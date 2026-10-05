import { createHash } from "node:crypto";
import { parseDocument, stringify } from "yaml";
import { enolaPolicyPattern } from "./enola-paths.ts";
import { CheckError } from "./errors.ts";
import { openSource, SourceError } from "./source.ts";
import { normaliseBiomeSarif, type ToolLog, type ToolRun } from "./static.ts";

/** The base's policy files and the runner's fixed configuration. */
export type EnolaPolicyState = {
	files: { path: string; text: string }[];
	config: string;
	hash: string;
	failOn: string[];
};

/** Enola policy over one repository, with executable providers disabled. */
export class EnolaPolicy {
	readonly #state: EnolaPolicyState;
	private constructor(state: EnolaPolicyState) {
		this.#state = state;
	}

	/** Reads bounded, non-symlink policy files at the base revision. */
	static async load(repoRoot: string, commit: string): Promise<EnolaPolicy> {
		const source = await openSource(repoRoot, { kind: "revision", commit });
		const files: EnolaPolicyState["files"] = [];
		let bytes = 0;
		for (const path of (await source.findPaths(enolaPolicyPattern)).sort()) {
			const text = await source.readText(path, 256 * 1024);
			if (text === undefined) throw new CheckError("unreadable", "static.enola", `Missing policy ${path}`);
			bytes += Buffer.byteLength(text);
			if (bytes > 1024 * 1024) throw new CheckError("outputTooLarge", "static.enola", "Enola policy exceeds 1 MiB");
			files.push({ path, text });
		}
		return EnolaPolicy.from(files);
	}

	/** Builds the effective single-repository configuration from the base's files. */
	static from(files: EnolaPolicyState["files"]): EnolaPolicy {
		const ordered = [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
		const configFile =
			ordered.find((file) => file.path === "enola.yaml") ?? ordered.find((file) => file.path === "mcp-arch.yaml");
		let config: Record<string, unknown> = {};
		if (configFile) {
			const document = parseDocument(configFile.text);
			const problem = document.errors[0] ?? document.warnings[0];
			if (problem)
				throw new CheckError("invalidOutput", "static.enola", `Invalid Enola configuration: ${problem.message}`);
			const value: unknown = document.toJS();
			if (typeof value !== "object" || value === null || Array.isArray(value))
				throw new CheckError("invalidOutput", "static.enola", "Enola configuration must be a mapping");
			config = value as Record<string, unknown>;
		}
		delete config.repos;
		config.repo = ".";
		config.providers = [];
		config.output = { dir: ".enola" };
		config.history = { enabled: false };
		const hasConstraints = ordered.some(
			(file) =>
				file.path.startsWith("enola/constraints/") ||
				(file.path === "enola-intent.yaml" && /^(?:rules|recipes):/m.test(file.text)),
		);
		const failOn = hasConstraints ? ["constraints"] : [];
		const text = stringify(config);
		const hash = createHash("sha256")
			.update(
				JSON.stringify({
					files: ordered,
					config: text,
					flags: ["--generate", "--format=sarif", ...failOn],
					schema: 1,
				}),
			)
			.digest("hex");
		return new EnolaPolicy({ files: structuredClone(ordered), config: text, hash, failOn });
	}

	/** Compares raw head policy without letting an invalid head configuration judge the check. */
	async differs(repoRoot: string, commit: string): Promise<boolean> {
		const source = await openSource(repoRoot, { kind: "revision", commit });
		const files: EnolaPolicyState["files"] = [];
		for (const path of (await source.findPaths(enolaPolicyPattern)).sort()) {
			try {
				const text = await source.readText(path, 256 * 1024);
				if (text !== undefined) files.push({ path, text });
			} catch (error) {
				if (error instanceof SourceError && (error.code === "symlink" || error.code === "tooLarge")) return true;
				throw error;
			}
		}
		return JSON.stringify(files) !== JSON.stringify(this.#state.files);
	}

	/** Returns policy data for the runner and cache key. */
	toJSON(): EnolaPolicyState {
		return structuredClone(this.#state);
	}
	/** The hash of policy names, contents, flags, and the cache schema. */
	get hash(): string {
		return this.#state.hash;
	}
}

/** Reads Enola SARIF, excluding resolved and explicitly suppressed results. Unlocated results sit on its policy. */
export function normaliseEnolaSarif(output: string, run: ToolRun): ToolLog {
	try {
		const parsed: unknown = JSON.parse(output);
		if (typeof parsed !== "object" || parsed === null) throw new Error("Not a SARIF object");
		const log = parsed as { version?: unknown; runs?: { results?: unknown }[] };
		if (log.version !== "2.1.0" || log.runs?.length !== 1 || !Array.isArray(log.runs[0]?.results))
			throw new Error("Not one SARIF 2.1.0 run");
		const results = log.runs[0].results.flatMap((value: unknown) => {
			if (typeof value !== "object" || value === null) throw new Error("Invalid result");
			const result = value as {
				properties?: { bucket?: unknown };
				suppressions?: unknown[];
				locations?: unknown[];
				ruleId?: unknown;
				level?: unknown;
			};
			if (result.properties?.bucket === "resolved" || (result.suppressions?.length ?? 0) > 0) return [];
			if (typeof result.ruleId !== "string" || !["error", "warning", "note", "none"].includes(String(result.level)))
				throw new Error("Missing rule or severity");
			return [
				{
					...result,
					locations: result.locations?.length
						? result.locations
						: [
								{
									physicalLocation: {
										artifactLocation: { uri: "enola-intent.yaml" },
										region: { startLine: 1 },
									},
								},
							],
				},
			];
		});
		const normalised = normaliseBiomeSarif(JSON.stringify({ runs: [{ results }] }), run);
		return {
			...normalised,
			runs: [{ ...normalised.runs[0], tool: { driver: { name: "enola", version: run.version } } }],
		};
	} catch (cause) {
		throw new CheckError(
			"invalidOutput",
			"static.enola",
			`Enola wrote unreadable SARIF: ${cause instanceof Error ? cause.message : String(cause)}`,
			{ cause },
		);
	}
}

/** A snapshot identity and its original receipt, recorded beside the check. */
export type EnolaSnapshot = { commit: string; snapshotId: string; receipt: string; cacheKey?: string };
