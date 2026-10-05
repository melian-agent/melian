import {
	type Decider,
	type DeciderAnswer,
	DecisionError,
	type DecisionRequest,
	questionFingerprint,
} from "@melian-agent/core";

/**
 * One recorded answer: a weight for each option, and, where known, the {@link questionFingerprint} of the question it
 * was recorded for, so it is refused once the question changes.
 */
export type RecordedAnswer = {
	readonly distribution: Readonly<Record<string, number>>;
	readonly fingerprint?: string;
};

/** Each question set's recordings, by its name: the version they were recorded for, and each question's answer by ID. */
export type Recordings = Readonly<
	Record<string, { readonly version: string; readonly answers: Readonly<Record<string, RecordedAnswer>> }>
>;

/**
 * A decider that answers from recordings rather than a model, for tests and for replaying stored decisions. It keeps
 * every request it was asked, in order. A question with no recording is a {@link DecisionError} `unrecorded`, so a
 * test that forgot one fails closed as a real provider's failure would; a recording made for another version of the
 * question set, or with a fingerprint the question no longer has, is `staleRecording`.
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
		const { name, version } = request.questionSet;
		const recorded = Object.hasOwn(this.#recordings, name) ? this.#recordings[name]! : undefined;
		if (recorded !== undefined && recorded.version !== version) {
			throw new DecisionError(
				"staleRecording",
				`the recordings of ${name} are for version ${recorded.version}, and the question set is at ${version}`,
			);
		}
		const answers = recorded?.answers ?? {};
		return {
			answers: request.questions.map((question) => {
				if (!Object.hasOwn(answers, question.id)) {
					throw new DecisionError("unrecorded", `no answer to ${question.id} in ${name} is recorded`, {
						question: question.id,
					});
				}
				const { distribution, fingerprint } = answers[question.id]!;
				if (fingerprint !== undefined && fingerprint !== questionFingerprint(question)) {
					throw new DecisionError(
						"staleRecording",
						`the recorded answer to ${question.id} is for another form of it`,
						{
							question: question.id,
						},
					);
				}
				return { question: question.id, distribution: { ...distribution } };
			}),
		};
	}
}
