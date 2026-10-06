import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { CheckError, ToolManifest, type ToolPin } from "@melian-agent/core";
import { ToolCache, type ToolFetch } from "./tool-cache.ts";

/** The shared cache and storage directory for one clone. */
export class CacheLocation {
	readonly root: string;
	private constructor(root: string) {
		this.root = root;
	}
	/** Resolves the existing state-directory rule, clearing git's inherited repository variables. */
	static async open(repoRoot: string, environment: NodeJS.ProcessEnv = process.env): Promise<CacheLocation> {
		const env = Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith("GIT_")));
		const reported = await new Promise<string>((done, fail) =>
			execFile(
				"git",
				["-C", repoRoot, "rev-parse", "--git-common-dir"],
				{ env, timeout: 10_000 },
				(error, stdout) => (error ? fail(error) : done(stdout.trim())),
			),
		);
		const common = isAbsolute(reported) ? reported : resolve(repoRoot, reported);
		const configured = environment.MELIAN_STATE_DIR ?? "";
		const root =
			configured === ""
				? join(common, "melian")
				: join(
						resolve(repoRoot, configured),
						createHash("sha256")
							.update(await realpath(common))
							.digest("hex")
							.slice(0, 16),
					);
		return new CacheLocation(root);
	}
}

/** Melian's own pins and their local verified cache. */
export class ToolProvisioning {
	readonly manifest: ToolManifest;
	readonly cache: ToolCache;
	readonly platform: string;
	private constructor(manifest: ToolManifest, cache: ToolCache, platform: string) {
		this.manifest = manifest;
		this.cache = cache;
		this.platform = platform;
	}

	/** Opens Melian's bundled manifest; test hosts may inject pins and a local fetch. */
	static async open(
		repoRoot: string,
		options: { manifest?: ToolManifest; root?: string; platform?: string; fetch?: ToolFetch } = {},
	): Promise<ToolProvisioning> {
		const manifest = options.manifest ?? (await ToolProvisioning.manifest());
		const root = options.root ?? (await CacheLocation.open(repoRoot)).root;
		const platform = options.platform ?? `${process.platform}-${process.arch === "x64" ? "amd64" : process.arch}`;
		return new ToolProvisioning(manifest, await ToolCache.open(root, { fetch: options.fetch }), platform);
	}

	/** Reads the manifest shipped with Melian, never one from repoRoot. */
	static async manifest(): Promise<ToolManifest> {
		const path = import.meta.url.endsWith(".ts") ? "../../../tools.yaml" : "../tools.yaml";
		const text = await readFile(new URL(path, import.meta.url), "utf8");
		return ToolManifest.parse(text);
	}

	/** Returns the pin used for every run of the tool. */
	tool(name: string): ToolPin {
		return this.manifest.tool(name);
	}
	/** Materialises the pinned executable, turning provisioning failures into failed check codes. */
	async binary(name: string): Promise<string> {
		try {
			return await this.cache.materialise(this.tool(name), this.platform);
		} catch (cause) {
			throw new CheckError(
				(cause as { code?: string }).code === "toolMissing" ? "toolMissing" : "toolFailed",
				`static.${name}`,
				cause instanceof Error ? cause.message : String(cause),
				{ cause },
			);
		}
	}
}
