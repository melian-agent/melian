import { type ChoiceQuestion, type DecisionRequest, KeyedRequest, type QuestionSet } from "@melian-agent/core";
import { identityNonce, triageBoundary } from "./untrusted.ts";

/** What triage asks a decider, before it is keyed. */
export type TriageRequestInput = {
	readonly decider: { readonly name: string; readonly version?: string };
	readonly questionSet: QuestionSet;
	readonly questions: readonly ChoiceQuestion[];
	/** The change as triage shows it, rendered inside boundaries of `nonce`, and whether its size limit cut it. */
	readonly change: (nonce: string) => { readonly text: string; readonly cut: boolean };
	readonly nonce: string;
};

type TriageRequestBody = {
	decider: string;
	deciderVersion?: string;
	questionSet: QuestionSet;
	questions: readonly ChoiceQuestion[];
	state: string;
	inputCut: boolean;
};

function stateOf(input: TriageRequestInput, nonce: string): { state: string; cut: boolean } {
	const { text, cut } = input.change(nonce);
	return { state: [triageBoundary(nonce), "## The change", text].join("\n\n"), cut };
}

/**
 * Triage's request, keyed by what the decider is asked: the decider and the fixed text it adds, the question set, the
 * questions and the change as shown, rendered under a fixed nonce. The decider reads `unkeyed.nonce`, the same request
 * under the review's own nonce.
 */
export function triageRequest(
	input: TriageRequestInput,
): KeyedRequest<TriageRequestBody, { readonly nonce: DecisionRequest }> {
	const keyed = stateOf(input, identityNonce);
	const shown = stateOf(input, input.nonce);
	const { questionSet, questions } = structuredClone({ questionSet: input.questionSet, questions: input.questions });
	return KeyedRequest.of(
		"triage",
		{
			decider: input.decider.name,
			...(input.decider.version === undefined ? {} : { deciderVersion: input.decider.version }),
			questionSet,
			questions,
			state: keyed.state,
			inputCut: keyed.cut,
		},
		{ nonce: { questionSet, questions, state: shown.state } },
	);
}
