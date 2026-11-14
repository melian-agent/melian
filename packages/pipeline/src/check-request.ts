import {
	type HostFacts,
	KeyedRequest,
	type MelianConfig,
	type RecordJson,
	type RepositorySource,
	requestJson,
} from "@melian-agent/core";
import type { WriterTrust } from "./checks.ts";
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
	/** Present only when the configuration enables `static.mutation`. */
	readonly mutation?: {
		readonly stryker: { readonly version: string; readonly installation: unknown; readonly source: StaticToolSource };
		readonly writer: WriterTrust | null;
		readonly cold: boolean;
	};
	readonly host: HostFacts;
};

// Raised when what a check stores from a tool changes, so no run of an earlier build is reused: 2 keeps no Biome or tsc
// text.
const storedText = 2;

// Raised when how Melian chooses tsc's projects changes, so no run of an earlier build is reused: 2 asks tsc --showConfig.
const tscProjectRule = 2;

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
}: NonNullable<CheckRequestInput["mutation"]>): unknown {
	return { ...mutation, stryker: { ...stryker, source: { from: source.from } } };
}

/**
 * A check run's request, keyed by everything that decides its results: the configuration less its display keys, the
 * policy source, Melian's tool pins, the version and source of each static tool, Stryker's facts and the head's trust
 * when mutation testing is on, the build's own rules for what it stores, and the host it runs on. Only the paths that
 * name the host are left out.
 */
export function checkRequest(input: CheckRequestInput): KeyedRequest<RecordJson> {
	return KeyedRequest.of(
		"check",
		requestJson({
			config: decisive(input.config),
			source: policySource(input.source),
			tools: input.tools,
			analysers: input.analysers,
			...(input.mutation === undefined ? {} : { mutation: strykerFrom(input.mutation) }),
			storedText,
			tscProjects: tscProjectRule,
			host: input.host,
		}),
	);
}
