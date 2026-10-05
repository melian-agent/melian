import type { TSchema } from "typebox";
import { DecisionError } from "./errors.ts";

/** A question a decider answers with a weight for each of its options. */
export interface ChoiceQuestion {
	readonly id: string;
	readonly text: string;
	readonly options: readonly string[];
}

/** A named, versioned set of questions, such as triage's. Every decision records the version it answered. */
export interface QuestionSet {
	readonly name: string;
	readonly version: string;
}

/**
 * What a decider is asked: one question set's questions about one state, the text every question is about. The caller
 * puts anything the change under review supplied inside its prompt boundaries before it reaches the state.
 */
export interface DecisionRequest {
	readonly questionSet: QuestionSet;
	readonly state: string;
	readonly questions: readonly ChoiceQuestion[];
}

/** A decider's answer to one question: a weight for each of its options. The weights need not sum to one. */
export interface ChoiceAnswer {
	readonly question: string;
	readonly distribution: Readonly<Record<string, number>>;
}

/** What a decider returns: an answer to each question, and the model that gave them, where a model did. */
export interface DeciderAnswer {
	readonly answers: readonly ChoiceAnswer[];
	readonly model?: string;
}

/**
 * The port a decision provider implements: typed questions about a state in, a distribution over each question's
 * options out. `calibrated` says whether the distribution is a calibrated probability, as a decision model's is and a
 * text model's is not. A decider throws when it cannot answer, and the caller fails closed. The adapters live in
 * `@melian-agent/decisions`.
 */
export interface Decider {
	readonly name: string;
	readonly calibrated: boolean;
	decide(request: DecisionRequest, signal?: AbortSignal): Promise<DeciderAnswer>;
}

/** What the LLM fallback adapter asks a text model: instructions, a prompt, and the one tool to answer through. */
export interface ToolRequest {
	readonly system: string;
	readonly prompt: string;
	readonly tool: { readonly name: string; readonly description: string; readonly parameters: TSchema };
}

/**
 * A text model the LLM fallback adapter asks: it answers a {@link ToolRequest} by calling the tool, and returns the
 * call's arguments, unvalidated. It throws when the model fails or calls no tool. The pipeline builds one over a
 * review's models.
 */
export interface TextModel {
	/** The model, as `provider/model-id`. */
	readonly name: string;
	answer(request: ToolRequest, signal?: AbortSignal): Promise<unknown>;
}

/** A {@link Decision} as JSON, which a Pi Durable document can hold. */
export type StoredDecision = {
	questionSet: { name: string; version: string };
	decider: string;
	calibrated: boolean;
	model?: string;
	answers: { question: string; distribution: Record<string, number>; chosen: string }[];
};

/** One question's answer as a {@link Decision} keeps it: every option's probability, in the question's order. */
export interface DecidedAnswer {
	readonly question: string;
	readonly distribution: Readonly<Record<string, number>>;
	readonly chosen: string;
}

/**
 * A decider's answers, validated against the questions it was asked and kept whole: the full distribution over every
 * option, not only the option chosen, so thresholds can be retuned from stored data and the answers joined to what
 * maintainers later did. A runtime view over {@link StoredDecision}.
 */
export class Decision {
	readonly questionSet: QuestionSet;
	readonly decider: string;
	readonly calibrated: boolean;
	readonly model?: string;
	readonly answers: readonly DecidedAnswer[];

	private constructor(stored: StoredDecision) {
		this.questionSet = stored.questionSet;
		this.decider = stored.decider;
		this.calibrated = stored.calibrated;
		this.model = stored.model;
		this.answers = stored.answers;
	}

	/** The decision Melian stored, trusted as it is. */
	static from(stored: StoredDecision): Decision {
		return new Decision(stored);
	}

	/**
	 * Validates `answer` against `request`: one answer per question asked and none to any other, weights only for the
	 * question's options, each finite and not negative, and some weight in all. Each distribution is normalised to sum
	 * to one over every option, an option given no weight at zero, and the option with the most weight is chosen, the
	 * first in the question's order on a tie. Throws {@link DecisionError}: `unanswered` for a question with no answer,
	 * `invalidAnswer` for anything else.
	 */
	static parse(
		request: DecisionRequest,
		answer: DeciderAnswer,
		decider: Pick<Decider, "name" | "calibrated">,
	): Decision {
		const byQuestion = new Map<string, ChoiceAnswer>();
		for (const each of answer.answers) {
			const asked = request.questions.some((question) => question.id === each.question);
			if (!asked || byQuestion.has(each.question)) {
				const why = asked ? "twice" : "though it was not asked";
				throw new DecisionError("invalidAnswer", `${decider.name} answered ${each.question} ${why}`, {
					question: each.question,
				});
			}
			byQuestion.set(each.question, each);
		}
		const answers = request.questions.map((question) => {
			const given = byQuestion.get(question.id);
			if (given === undefined) {
				throw new DecisionError("unanswered", `${decider.name} did not answer ${question.id}`, {
					question: question.id,
				});
			}
			return normalised(question, given.distribution, decider.name);
		});
		return new Decision({
			questionSet: { name: request.questionSet.name, version: request.questionSet.version },
			decider: decider.name,
			calibrated: decider.calibrated,
			...(answer.model === undefined ? {} : { model: answer.model }),
			answers,
		});
	}

	/** The option chosen for `question`, or `undefined` when the decision holds no answer to it. */
	chosen(question: string): string | undefined {
		return this.answers.find((answer) => answer.question === question)?.chosen;
	}

	toJSON(): StoredDecision {
		return {
			questionSet: { ...this.questionSet },
			decider: this.decider,
			calibrated: this.calibrated,
			...(this.model === undefined ? {} : { model: this.model }),
			answers: this.answers.map((answer) => ({ ...answer, distribution: { ...answer.distribution } })),
		};
	}
}

function normalised(
	question: ChoiceQuestion,
	weights: Readonly<Record<string, number>>,
	decider: string,
): StoredDecision["answers"][number] {
	const invalid = (detail: string) =>
		new DecisionError("invalidAnswer", `${decider} answered ${question.id} ${detail}`, { question: question.id });
	for (const [option, weight] of Object.entries(weights)) {
		if (!question.options.includes(option)) throw invalid(`with ${option}, which is not one of its options`);
		if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
			throw invalid(`with a weight of ${String(weight)} for ${option}`);
		}
	}
	const weightOf = (option: string) => (Object.hasOwn(weights, option) ? weights[option]! : 0);
	const total = question.options.reduce((sum, option) => sum + weightOf(option), 0);
	if (total === 0) throw invalid("with no weight on any option");
	const distribution = Object.fromEntries(question.options.map((option) => [option, weightOf(option) / total]));
	const chosen = question.options.reduce((best, option) => (weightOf(option) > weightOf(best) ? option : best));
	return { question: question.id, distribution, chosen };
}
