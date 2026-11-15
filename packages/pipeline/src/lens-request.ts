import { KeyedRequest, type LensToolName, type RecordJson, requestJson, type Severity } from "@melian-agent/core";
import { lensListedTools, recordPlan, reportFinding, runProbe, skipAttack } from "./lens-tools.ts";
import { answerPrompt, recordPlanPrompt } from "./probing.ts";
import { identityNonce, injectionPolicy } from "./untrusted.ts";

/** The input a lens run's model is given when the model before it on the route failed. */
export const continuePrompt =
	"The model reviewing this change failed, and you take over. Continue the review where it stopped: findings already recorded stay recorded, so report only what is still missing. Then answer with one line saying how many findings you reported.";

/** The fields of a lens run its request reads beyond the run itself: the tools it lists, and whether it probes. */
export type LensRequestRun = { readonly tools: readonly LensToolName[]; readonly probe?: unknown };

/** What a lens run is asked, before it is keyed. */
export type LensRequestInput<Run extends LensRequestRun> = {
	/**
	 * The run as the lens task stores it, with everything it quotes inside boundaries of `nonce`, and with the caller
	 * section only when `callers` is set: rule 5 of the shared record decision keeps that section out of the key.
	 */
	readonly run: (nonce: string, callers: boolean) => Run;
	readonly nonce: string;
	readonly base: string;
	readonly head: string;
	readonly escalateAt?: Severity;
	/** The key of the run a quick run escalates to, or why it is capped; absent for a run that never escalates. */
	readonly escalation?: { readonly next: string } | { readonly cap: string };
	/**
	 * The standards the instructions quote, by their raw text, their source less any preference file's path, and whether
	 * they are trusted. The rendered text alone can hide a change: under the fixed nonce, texts that differ only in a copy
	 * of the nonce render alike, and a change of source or trust can leave the text as it was.
	 */
	readonly standards: unknown;
};

type ToolSpec = { name: string; description: string; parameters: unknown };

type LensRequestBody = {
	run: RecordJson;
	policy: string;
	tools: ToolSpec[];
	continue: string;
	probing?: { tools: ToolSpec[]; plan: string; answer: string };
	base: string;
	head: string;
	escalateAt?: Severity;
	escalation?: { next: string } | { cap: string };
	standards: RecordJson;
};

const specOf = ({ name, description, parameters }: ToolSpec): ToolSpec => ({ name, description, parameters });

/**
 * A lens run's request, keyed by what its conversations are shown: the run under a fixed nonce, the injection policy
 * that renders ahead of its instructions, each tool its planner and prober are offered by name, description and
 * schema, the wording a failover and a probing run's reminders send, the revision's base and head, `escalateAt`,
 * the escalation by its next run's key, and the standards it quotes as their source gave them. Best-effort context stays out, as rule 5 of the shared record decision says:
 * the caller section, and the Enola graph its tools read. The lens task reads `unkeyed.bestEffort`, the run under the
 * review's own nonce with its caller section.
 */
export function lensRequest<Run extends LensRequestRun>(
	input: LensRequestInput<Run>,
): KeyedRequest<LensRequestBody, { readonly nonce: string; readonly bestEffort: Run }> {
	const keyed = input.run(identityNonce, false);
	const read = keyed.tools.map((tool) => lensListedTools[tool]);
	const probes = keyed.probe !== undefined;
	return KeyedRequest.of(
		"lens",
		{
			run: requestJson(keyed),
			policy: injectionPolicy(identityNonce),
			tools: [...read, reportFinding, ...(probes ? [recordPlan] : [])].map(specOf),
			continue: continuePrompt,
			...(probes
				? {
						probing: {
							tools: [...read, reportFinding, runProbe, skipAttack].map(specOf),
							plan: recordPlanPrompt,
							answer: answerPrompt([1, 2]),
						},
					}
				: {}),
			base: input.base,
			head: input.head,
			...(input.escalateAt === undefined ? {} : { escalateAt: input.escalateAt }),
			...(input.escalation === undefined ? {} : { escalation: { ...input.escalation } }),
			standards: requestJson(input.standards),
		},
		{ nonce: input.nonce, bestEffort: input.run(input.nonce, true) },
	);
}
