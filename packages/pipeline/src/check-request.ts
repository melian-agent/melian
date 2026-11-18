import {
	type DeterministicCheck,
	type HostFacts,
	KeyedRequest,
	type MelianConfig,
	type PolicyText,
	type RecordJson,
	type RepositorySource,
	requestJson,
} from "@melian-agent/core";
import type { WriterTrust } from "./checks.ts";
import type { InstallDigests } from "./mutation-static.ts";
import type { StaticToolSource } from "./static.ts";

/** A static tool a run would start, read before it starts: where it comes from and the version its manifest names. */
export type AnalyserFacts = { readonly from: StaticToolSource["from"]; readonly version: string };

/** What decides a check run's results, gathered before any check runs. */
export type CheckRequestInput = {
	readonly config: MelianConfig;
	readonly source: RepositorySource;
	/** Melian's own tool pins, as `ToolProvisioning.manifest()` writes them. */
	readonly tools: unknown;
	readonly analysers: { readonly biome: AnalyserFacts; readonly tsc: AnalyserFacts };
	/** The checkout's lockfiles and install records, which Biome and tsc resolve from. */
	readonly install: InstallDigests;
	/** Present only when the configuration enables `static.mutation`. */
	readonly mutation?: {
		readonly stryker: { readonly version: string; readonly installation: unknown; readonly source: StaticToolSource };
		readonly writer: WriterTrust | null;
		readonly cold: boolean;
	};
	readonly host: HostFacts;
	// The `LANG` every tool runs with, or null when unset. Keyed only with mutation, whose tests are the head's code.
	readonly lang: string | null;
	/**
	 * For a working-tree source, every `melian.yaml` the guardrails would read for the touched paths, or `unread` when
	 * they could not be read whole, which makes the run not reusable.
	 */
	readonly policy?: readonly PolicyText[] | "unread";
};

/** The most UTF-8 a check request keys from a working tree's `melian.yaml` files together; past it a run is not reused. */
export const maxKeyedPolicyBytes = 1024 * 1024;

// Melian's own code of each check. Raise a check's number when its logic changes what it finds or how it reports, so
// no run of an earlier build is reused; nothing checks that you did until issue #437. Biome 2 and tsc 2 keep no tool
// text, and tsc 3 asks tsc --showConfig for its projects. Enola 2 and mutation 2 keep no tool text in a discriminator,
// and Enola 2 hashes a rule no policy declares. Biome 3, tsc 4, Enola 3 and mutation 3 stamp their sightings with the run.
const checkVersions: Readonly<Record<DeterministicCheck, number>> = {
	guardrails: 1,
	"static.biome": 3,
	"static.tsc": 4,
	"static.enola": 3,
	"static.mutation": 3,
};

// The configuration without its display-only keys, which change how a review reads and never what a check finds, so a
// change to one reuses the run. `language` joins them when it lands.
function decisive(config: MelianConfig): unknown {
	const { output: _, publish, ...rest } = config;
	const { emoji: __, ...kept } = publish;
	return { ...rest, publish: kept };
}

// Where a policy comes from, less the preference file's path, which names the host; `config` holds what the file says.
function policySource(source: RepositorySource): unknown {
	return source.kind === "revision" ? source : { kind: source.kind };
}

// Stryker's install path names the host; where it comes from and its installation's versions stay.
function strykerFrom({
	stryker: { source, ...stryker },
	...mutation
}: NonNullable<CheckRequestInput["mutation"]>): Record<string, unknown> {
	return { ...mutation, stryker: { ...stryker, source: { from: source.from } } };
}

// The first version of each static check's own code that stores none of its tool's text in a finding. A build before it
// stored Biome's and tsc's messages, or Enola's and the mutation check's in a discriminator.
const fixedTextSince: ReadonlyMap<string, number> = new Map([
	["static.biome", 2],
	["static.tsc", 2],
	["static.enola", 2],
	["static.mutation", 2],
]);

/**
 * Whether a check run's request asks for a version of `check` whose findings hold none of its tool's text, so another
 * host may be shown them. A request that is not a check run's, or names no version of `check`, proves nothing.
 */
export function writesFixedText(asked: KeyedRequest<RecordJson>, check: string): boolean {
	const since = fixedTextSince.get(check);
	const checks = asked.producer === "check" ? (asked.request as { checks?: unknown }).checks : undefined;
	const version =
		typeof checks === "object" && checks !== null ? (checks as Record<string, unknown>)[check] : undefined;
	return since !== undefined && typeof version === "number" && version >= since;
}

/**
 * Whether a run of this request may stand for a later one with the same key. A key holds what was read, so an input
 * that could not be read leaves nothing to compare, and the run is not reused.
 */
export function checkReusable(input: CheckRequestInput): boolean {
	return input.policy !== "unread" && input.install.identified;
}

/**
 * A check run's request, keyed by everything that decides its results: the configuration less its display keys, the
 * policy source, Melian's tool pins, the version and source of each static tool, the checkout's install, Stryker's facts,
 * the head's trust and the tools' `LANG` when mutation testing is on, the version of Melian's own code for each check,
 * the host it runs on, and a working tree's `melian.yaml` text. It leaves out the paths that name the host, `LANG` when
 * mutation is off, and `PATH`, `HOME` and `TMPDIR`, which no bounded fact stands for.
 */
export function checkRequest(input: CheckRequestInput): KeyedRequest<RecordJson> {
	return KeyedRequest.of(
		"check",
		requestJson({
			config: decisive(input.config),
			source: policySource(input.source),
			tools: input.tools,
			analysers: input.analysers,
			install: input.install,
			// Biome and tsc store no tool text, so `LANG` changes no finding of theirs; the head's tests can read it.
			...(input.mutation === undefined ? {} : { mutation: { ...strykerFrom(input.mutation), lang: input.lang } }),
			checks: checkVersions,
			host: input.host,
			policy: input.policy,
		}),
	);
}
