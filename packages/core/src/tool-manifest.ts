import Type, { type Static } from "typebox";
import { parseYaml } from "./config.ts";

const strict = { additionalProperties: false } as const;
const text = Type.String({ minLength: 1 });
const date = Type.String({ pattern: "^\\d{4}-\\d{2}-\\d{2}(?:T.*Z)?$" });
const artifact = Type.Object(
	{ url: text, sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }), binary: Type.Optional(text) },
	strict,
);

/** The standalone tools Melian pins, and the execution misses that order later tools. */
export const toolManifestSchema = Type.Object(
	{
		format_version: Type.Literal(1),
		tools: Type.Record(
			Type.String({ pattern: "^[a-z][a-z0-9-]*$" }),
			Type.Object(
				{
					version: Type.String({ pattern: "^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$" }),
					source: Type.Object(
						{ repository: Type.String({ pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }), tag: text },
						strict,
					),
					published: date,
					platforms: Type.Record(Type.String({ pattern: "^[a-z]+-(?:amd64|arm64)$" }), artifact),
					exception: Type.Optional(Type.Object({ reason: text, added: date }, strict)),
				},
				strict,
			),
		),
		misses: Type.Array(
			Type.Object(
				{
					record: text,
					finding: text,
					tool: Type.Union([
						Type.Literal("enola"),
						Type.Literal("opengrep"),
						Type.Literal("gitleaks"),
						Type.Literal("tests"),
						Type.Literal("repro-run"),
						Type.Literal("none"),
					]),
				},
				strict,
			),
		),
	},
	strict,
);

/** The manifest's stored JSON. */
export type ToolManifestState = Static<typeof toolManifestSchema>;
/** A pinned download; absence of binary means the download itself is executable. */
export type ToolArtifact = Static<typeof artifact>;
/** One named tool pin. */
export type ToolPin = ToolManifestState["tools"][string] & { name: string };

/** A manifest or a requested pin cannot be used. */
export class ToolManifestError extends Error {
	readonly code: "invalidManifest" | "toolMissing" | "quarantine";
	constructor(code: ToolManifestError["code"], message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "ToolManifestError";
		this.code = code;
	}
}

/** Melian's own pins. A reviewed repository cannot supply or override this manifest. */
export class ToolManifest {
	readonly #state: ToolManifestState;
	private constructor(state: ToolManifestState) {
		this.#state = state;
	}

	/** Parses strict YAML and refuses unsafe URLs, archive paths, and invalid dates. */
	static parse(text: string): ToolManifest {
		try {
			const state = parseYaml(
				text,
				{ file: "tools.yaml", where: "tools.yaml" },
				toolManifestSchema,
			) as ToolManifestState;
			for (const [name, tool] of Object.entries(state.tools)) {
				if (!Number.isFinite(Date.parse(tool.published)) || !tool.published.includes("T"))
					throw new Error(`${name}: invalid publication timestamp`);
				if (tool.exception && (!Number.isFinite(Date.parse(tool.exception.added)) || !tool.exception.reason.trim()))
					throw new Error(`${name}: invalid exception`);
				if (!Object.keys(tool.platforms).length) throw new Error(`${name}: no platforms`);
				for (const pin of Object.values(tool.platforms)) {
					const url = new URL(pin.url);
					if (
						url.protocol !== "https:" ||
						!["github.com"].includes(url.hostname) ||
						url.username ||
						url.password ||
						url.port ||
						url.search ||
						url.hash
					)
						throw new Error(`${name}: download must use HTTPS on github.com`);
					if (
						pin.binary !== undefined &&
						(/^[\\/]/.test(pin.binary) ||
							pin.binary.includes("\\") ||
							pin.binary.split("/").some((part) => ["..", ".", ""].includes(part)))
					)
						throw new Error(`${name}: unsafe archive path`);
				}
			}
			return new ToolManifest(state);
		} catch (cause) {
			throw new ToolManifestError("invalidManifest", cause instanceof Error ? cause.message : String(cause), {
				cause,
			});
		}
	}

	/** Returns the named pin or refuses an absent tool. */
	tool(name: string): ToolPin {
		if (!Object.hasOwn(this.#state.tools, name))
			throw new ToolManifestError("toolMissing", `No tool is named ${name}`);
		return { ...structuredClone(this.#state.tools[name]!), name };
	}

	/** Returns the platform's download or refuses an unsupported platform. */
	artifact(name: string, platform: string): ToolArtifact {
		const tool = this.tool(name);
		if (!Object.hasOwn(tool.platforms, platform))
			throw new ToolManifestError("toolMissing", `${name} has no pin for ${platform}`);
		return tool.platforms[platform]!;
	}

	/** Returns quarantine failures. Reviewed exceptions remain harmless once the release ages out. */
	check(now: number, windowDays: number): string[] {
		if (!Number.isFinite(now) || !Number.isFinite(windowDays) || windowDays < 0)
			throw new ToolManifestError("quarantine", "Invalid quarantine clock or window");
		return Object.entries(this.#state.tools).flatMap(([name, tool]) => {
			if ((now - Date.parse(tool.published)) / 86_400_000 >= windowDays) return [];
			if (tool.exception && Date.parse(tool.exception.added) <= now) return [];
			return [`${name}@${tool.version} published ${tool.published}, inside the ${windowDays}-day window`];
		});
	}

	/** Returns a copy of the stored manifest. */
	toJSON(): ToolManifestState {
		return structuredClone(this.#state);
	}
}
