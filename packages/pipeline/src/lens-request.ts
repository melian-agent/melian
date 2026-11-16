import { KeyedRequest, type LensToolName, type RecordJson, requestJson, type Severity } from "@melian-agent/core";
import { piVersions } from "./harness.ts";
import {
	injectionPolicySection,
	lensListedTools,
	lensToolLimits,
	recordPlan,
	reportFinding,
	runProbe,
	skipAttack,
} from "./lens-tools.ts";
import { probingWording, probingWordingOf } from "./probing.ts";
import { identityNonce, injectionPolicy } from "./untrusted.ts";

/** The input a lens run's model is given when the model before it on the route failed. */
export const continuePrompt =
	"The model reviewing this change failed, and you take over. Continue the review where it stopped: findings already recorded stay recorded, so report only what is still missing. Then answer with one line saying how many findings you reported.";

/**
 * The fields of a lens run its request reads beyond the run itself: its lens, whose probing wording it keys, the tools
 * it lists, and whether it probes.
 */
export type LensRequestRun = {
	readonly name: string;
	readonly tools: readonly LensToolName[];
	readonly probe?: { readonly probesAs?: string; readonly [field: string]: unknown };
};

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

type ToolSpec = {
	name: string;
	description: string;
	parameters: unknown;
	outputLimits?: { readonly maxBytes?: number; readonly maxLines?: number };
	argumentBytes?: number;
};

type LensRequestBody = {
	run: RecordJson;
	pi: { durable: string; ai: string };
	policy: { section: string; text: string };
	tools: ToolSpec[];
	limits: typeof lensToolLimits;
	continue: string;
	probing?: { tools: ToolSpec[] };
	base: string;
	head: string;
	escalateAt?: Severity;
	escalation?: { next: string } | { cap: string };
	wording?: Readonly<Record<string, string>>;
	standards: RecordJson;
};

// What a tool shows a lens: its name, description and schema, and the limits on what it takes and returns.
const specOf = ({ name, description, parameters, outputLimits, argumentBytes }: ToolSpec): ToolSpec => ({
	name,
	description,
	parameters,
	...(outputLimits === undefined ? {} : { outputLimits: { ...outputLimits } }),
	...(argumentBytes === undefined ? {} : { argumentBytes }),
});

/**
 * A lens run's request, keyed by what its conversations are shown: the run under a fixed nonce, the installed Pi
 * Durable and pi-ai releases that render and send it, the injection policy that renders ahead of its instructions with
 * the name of the section that tags it, each tool its planner and prober are offered by name, description and
 * schema, the wording a failover sends, the revision's base and head, `escalateAt`, the escalation by its next run's
 * key, the probing wording of its own lens for a run that probes and the shared lines for one that escalates, and the
 * standards it quotes as their source gave them. Best-effort context stays out, as rule 5 of the shared record decision
 * says: the caller section, and the Enola graph its tools read. The lens task reads `unkeyed.bestEffort`, the run under
 * the review's own nonce with its caller section.
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
			pi: { ...piVersions },
			policy: { section: injectionPolicySection.key, text: injectionPolicy(identityNonce) },
			tools: [...read, reportFinding, ...(probes ? [recordPlan] : [])].map(specOf),
			limits: lensToolLimits,
			continue: continuePrompt,
			...(probes
				? {
						probing: {
							tools: [...read, reportFinding, runProbe, skipAttack].map(specOf),
						},
					}
				: {}),
			base: input.base,
			head: input.head,
			...(input.escalateAt === undefined ? {} : { escalateAt: input.escalateAt }),
			...(input.escalation === undefined ? {} : { escalation: { ...input.escalation } }),
			// A planner and prober read their lens's wording, the shared lines and its own. The run escalated to, which is
			// copied only with this run, reads this run's findings in the shared lines, and its own key holds its lens's.
			...(probes
				? { wording: probingWordingOf(keyed.probe?.probesAs ?? keyed.name) }
				: input.escalation !== undefined && "next" in input.escalation
					? { wording: probingWording }
					: {}),
			standards: requestJson(input.standards),
		},
		{ nonce: input.nonce, bestEffort: input.run(input.nonce, true) },
	);
}
