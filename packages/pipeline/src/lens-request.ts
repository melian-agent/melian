import { KeyedRequest, type LensToolName, type RecordJson, requestJson, type Severity } from "@melian-agent/core";
import { melianInstall } from "./code-version.ts";
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

/**
 * The input a lens run's conversation, its planner's or its prober's, gives the next model on its route when the model
 * before it failed: `continue` when the conversation holds work an earlier model did, and `fresh` when none did, so
 * the next model is never told that work it must do was already done.
 */
export const handoverWording = Object.freeze({
	continue:
		"The model reviewing this change failed, and you take over. Continue the review where it stopped: findings already recorded stay recorded, so report only what is still missing. Then answer with one line saying how many findings you reported.",
	fresh: "The model before you failed before it started, so none of this work is done and nothing is recorded. Do the work your instructions and the input above describe, from the beginning. Then answer with one line saying what you recorded.",
});

/**
 * The fields of a lens run its request reads beyond the run itself: its lens, whose probing wording it keys, the tools
 * it lists, and whether it probes.
 */
export type LensRequestRun = {
	readonly name: string;
	readonly tools: readonly LensToolName[];
	readonly probe?: { readonly probesAs?: string; readonly [field: string]: unknown };
};

// Which installed instrumenter answers `list_mutants`: its version, read from the package it resolves to, whether that
// is the checkout's install or Melian's, and the digest of the installed packages beneath it, Babel among them;
// `unavailable` when neither resolves.
export type MutantLister =
	| {
			readonly version: string;
			readonly source: "checkout" | "melian";
			readonly packages: string;
			readonly identified: boolean;
	  }
	| "unavailable";

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
	/** The instrumenter, required for a run offered `list_mutants`, whose list it decides, and keyed only for one. */
	readonly mutants?: MutantLister;
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
	packages: string;
	policy: { section: string; text: string };
	tools: ToolSpec[];
	limits: typeof lensToolLimits;
	handover: typeof handoverWording;
	probing?: { tools: ToolSpec[] };
	base: string;
	head: string;
	escalateAt?: Severity;
	escalation?: { next: string } | { cap: string };
	wording?: Readonly<Record<string, string>>;
	standards: RecordJson;
	mutants?: MutantLister;
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
 * A lens run's request, keyed by what its conversations are shown: the run under a fixed nonce, the installed packages
 * beneath Pi Durable and pi-ai, which render and send it, the injection policy that renders ahead of its instructions with
 * the name of the section that tags it, each tool its planner and prober are offered by name, description and
 * schema, both wordings a failover may send, the revision's base and head, `escalateAt`, the escalation by its next run's
 * key, the probing wording of its own lens for a run that probes and the shared lines for one that escalates, the
 * standards it quotes as their source gave them, and, for a run offered `list_mutants`, the instrumenter that answers
 * it. Best-effort context stays out, as rule 5 of the shared record decision says: the caller section, and the Enola
 * graph its tools read. The lens task reads `unkeyed.bestEffort`, the run under the review's own nonce with its caller
 * section.
 */
export function lensRequest<Run extends LensRequestRun>(
	input: LensRequestInput<Run>,
): KeyedRequest<LensRequestBody, { readonly nonce: string; readonly bestEffort: Run }> {
	const keyed = input.run(identityNonce, false);
	const read = keyed.tools.map((tool) => lensListedTools[tool]);
	const probes = keyed.probe !== undefined;
	const lists = keyed.tools.includes("list_mutants");
	if (lists && input.mutants === undefined) throw new Error("a run offered list_mutants needs its instrumenter keyed");
	return KeyedRequest.of(
		"lens",
		{
			run: requestJson(keyed),
			packages: melianInstall().digest,
			policy: { section: injectionPolicySection.key, text: injectionPolicy(identityNonce) },
			tools: [...read, reportFinding, ...(probes ? [recordPlan] : [])].map(specOf),
			limits: lensToolLimits,
			handover: handoverWording,
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
			...(lists ? { mutants: input.mutants! } : {}),
		},
		{ nonce: input.nonce, bestEffort: input.run(input.nonce, true) },
	);
}
