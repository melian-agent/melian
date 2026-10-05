import { type Decider, type DeciderAnswer, DecisionError, type DecisionRequest } from "@melian-agent/core";

/** Each question's recorded weights, by question set name, then question ID, then option. */
export type Recordings = Readonly<Record<string, Readonly<Record<string, Readonly<Record<string, number>>>>>>;

/**
 * A decider that answers from recordings rather than a model, for tests and for replaying stored decisions. It keeps
 * every request it was asked, in order. A question with no recording is a {@link DecisionError} `unrecorded`, so a
 * test that forgot one fails closed as a real provider's failure would.
 */
export class RecordedDecider implements Decider {
	readonly name: string;
	readonly calibrated: boolean;
	readonly requests: DecisionRequest[];
	readonly #recordings: Recordings;

	constructor(recordings: Recordings, options: { readonly name?: string; readonly calibrated?: boolean } = {}) {
		this.name = options.name ?? "recorded";
		this.calibrated = options.calibrated ?? false;
		this.requests = [];
		this.#recordings = recordings;
	}

	async decide(request: DecisionRequest): Promise<DeciderAnswer> {
		this.requests.push(request);
		const { name } = request.questionSet;
		const recorded = Object.hasOwn(this.#recordings, name) ? this.#recordings[name]! : {};
		const answers = request.questions.map((question) => {
			if (!Object.hasOwn(recorded, question.id)) {
				throw new DecisionError("unrecorded", `no answer to ${question.id} in ${name} is recorded`, {
					question: question.id,
				});
			}
			return { question: question.id, distribution: { ...recorded[question.id] } };
		});
		return { answers };
	}
}
