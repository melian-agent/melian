import { posix } from "node:path";
import { parseJsonc } from "@melian-agent/core";
import type { Run } from "./static.ts";

const biomeConfiguration = /(?:^|\/)\.?biome\.jsonc?$/;

const strings = (value: unknown): string[] =>
	(Array.isArray(value) ? value : [value]).filter((each): each is string => typeof each === "string");

// What each file of a tool's configuration names as another configuration file, and, for Biome, as a Grit plugin, which
// is only located, never parsed. Biome's `"//"` is the root configuration, checked as a configuration of its own.
const named = {
	biome: (config: Record<string, unknown>) => ({
		configurations: strings(config.extends).filter((entry) => entry !== "//"),
		plugins: (Array.isArray(config.plugins) ? config.plugins : [config.plugins]).flatMap((plugin) =>
			strings(typeof plugin === "object" && plugin !== null ? (plugin as { path?: unknown }).path : plugin),
		),
	}),
	tsc: (config: Record<string, unknown>) => ({
		configurations: [
			...strings(config.extends),
			...(Array.isArray(config.references) ? config.references : []).flatMap((reference) =>
				strings((reference as { path?: unknown } | null)?.path),
			),
		],
		plugins: [],
	}),
};

// Follows a revision's Biome or tsc configuration through every `extends`, `plugins` and `references` entry before the
// tool runs, and refuses the run when an entry names a file outside the worktree and the checkout's install. Biome
// quotes a file it cannot parse under the name of the file that extended it, so its stderr cannot be filtered by file.
export class ConfigurationScope {
	readonly run: Run;
	readonly root: string;
	readonly install: string | undefined;
	readonly seen = new Set<string>();

	private constructor(run: Run, root: string, install: string | undefined) {
		this.run = run;
		this.root = root;
		this.install = install;
	}

	static async refusal(
		run: Run,
		root: string,
		files: readonly string[],
		installed: string | undefined,
	): Promise<string | undefined> {
		const { tool } = run.input;
		if (tool !== "biome" && tool !== "tsc") return undefined;
		const install = installed === undefined ? undefined : await run.input.env.canonicalPath(installed, run.context);
		const scope = new ConfigurationScope(run, root, install?.ok === true ? install.value : undefined);
		const starts =
			tool === "biome"
				? files.filter((file) => biomeConfiguration.test(file))
				: [(run.input.settings as { project: string }).project];
		for (const start of starts) {
			const refused = await scope.follow(start, posix.join(root, start), tool);
			if (refused !== undefined) return refused;
		}
		return undefined;
	}

	private within(path: string, directory: string | undefined): boolean {
		return directory !== undefined && (path === directory || path.startsWith(`${directory}/`));
	}

	private async follow(label: string, path: string, tool: "biome" | "tsc", parse = true): Promise<string | undefined> {
		const { env } = this.run.input;
		const canonical = await env.canonicalPath(path, this.run.context);
		if (!canonical.ok) {
			return canonical.error.code === "not_found" || canonical.error.code === "not_directory"
				? undefined
				: `${label} could not be resolved: ${canonical.error.message}`;
		}
		const real = canonical.value;
		if (!this.within(real, this.root)) {
			return this.within(real, this.install) ? undefined : `${label} resolves outside the checkout`;
		}
		if (!parse || this.seen.has(real)) return undefined;
		this.seen.add(real);
		const text = await env.readTextFile(real, this.run.context);
		if (!text.ok) return undefined;
		const config = parseJsonc(text.value);
		if (typeof config !== "object" || config === null || Array.isArray(config)) {
			return `${label} is not JSON Melian can read, so it cannot tell which files ${tool} would read through it`;
		}
		const { configurations, plugins } = named[tool](config as Record<string, unknown>);
		for (const [entry, parsed] of [
			...configurations.map((each) => [each, true] as const),
			...plugins.map((each) => [each, false] as const),
		]) {
			const refused = await this.entry(label, real, entry, tool, parsed);
			if (refused !== undefined) return refused;
		}
		return undefined;
	}

	// Biome reads an entry ending in `.json` or `.jsonc` as a path, as tsc does one that starts with `.` or `/`; any
	// other entry is a package in node_modules.
	private async entry(
		label: string,
		from: string,
		entry: string,
		tool: "biome" | "tsc",
		parse: boolean,
	): Promise<string | undefined> {
		const path = entry.startsWith(".") || entry.startsWith("/") || (tool === "biome" && /\.jsonc?$/.test(entry));
		if (!path) return this.packageEntry(label, entry);
		const target = posix.resolve(posix.dirname(from), entry);
		if (!this.within(target, this.root)) return `${label} names ${entry}, which is outside the checkout`;
		const candidates = tool === "tsc" ? [target, `${target}.json`, posix.join(target, "tsconfig.json")] : [target];
		for (const candidate of candidates) {
			const refused = await this.follow(`${label} names ${entry}, which`, candidate, tool, parse);
			if (refused !== undefined) return refused;
		}
		return undefined;
	}

	// A package's configuration is trusted only from the checkout's install, which the maintainer made from the lockfile.
	private async packageEntry(label: string, entry: string): Promise<string | undefined> {
		const segments = entry.split("/");
		if (segments.includes("..")) return `${label} names ${entry}, which climbs out of its package`;
		const name = segments.slice(0, entry.startsWith("@") ? 2 : 1).join("/");
		const resolved = await this.run.input.env.canonicalPath(
			posix.join(this.root, "node_modules", name),
			this.run.context,
		);
		if (resolved.ok && this.within(resolved.value, this.install) && !this.within(resolved.value, this.root)) {
			return undefined;
		}
		return `${label} names the package ${name}, which the checkout's install does not provide`;
	}
}
