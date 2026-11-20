import { createHash } from "node:crypto";
import { type Dirent, existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalJson } from "@melian-agent/core";

export class InstalledPackagesError extends Error {
	readonly code = "installed-packages";
	constructor(message: string) {
		super(message);
		this.name = "InstalledPackagesError";
	}
}

// The most directories Melian reads to key an install; past it, keying fails.
export const maxInstallDirectories = 50_000;

type Mode = "modules" | "scope" | "package" | "tree";

/**
 * Every installed copy and every link beneath an install root, which fixes what each import beneath it reaches. The
 * install root is the outermost directory whose `node_modules` Node searches from the module the install is read from.
 * The decision of 2026-11-20 says what it leaves out.
 */
// A place beneath the install root, its kind, and what that kind records there.
export type InstallEntry = readonly string[];

export class Install {
	readonly entries: readonly InstallEntry[];
	/** The places beneath the root that link out of it, each of which leaves the install unidentified. */
	readonly outside: readonly string[];

	private constructor(entries: readonly InstallEntry[], outside: readonly string[]) {
		this.entries = entries;
		this.outside = outside;
	}

	/** Reads the install Node resolves from `from`, a module's file URL or path, failing past `limit` directories. */
	static read(from: string, limit = maxInstallDirectories): Install {
		let start: string;
		try {
			start = dirname(realpathSync(from.startsWith("file:") ? fileURLToPath(from) : from));
		} catch {
			throw new InstalledPackagesError(`Melian cannot read the module ${from} to find its install.`);
		}
		const chain = ancestors(start).filter((directory) => existsSync(join(directory, "node_modules")));
		const root = chain.at(-1);
		if (root === undefined)
			throw new InstalledPackagesError(`Melian cannot key its install: no node_modules holds the module ${from}.`);
		const walk = new Walk(root, limit);
		walk.run(chain.map((directory) => join(directory, "node_modules")));
		return new Install(walk.entries(), walk.outside());
	}

	/** Whether nothing beneath the root links out of it, so a run keyed by the install may stand for another. */
	get identified(): boolean {
		return this.outside.length === 0;
	}

	get digest(): string {
		return createHash("sha256").update(canonicalJson(this.entries)).digest("hex");
	}
}

// `directory` and each directory above it, nearest first.
function ancestors(directory: string): string[] {
	const found = [directory];
	for (let parent = dirname(directory); parent !== found.at(-1); parent = dirname(parent)) found.push(parent);
	return found;
}

class Walk {
	readonly #root: string;
	readonly #limit: number;
	readonly #entries = new Map<string, InstallEntry>();
	readonly #outside: string[] = [];
	readonly #entered = new Set<string>();
	readonly #followed = new Set<string>();
	readonly #queue: [string, Mode][] = [];

	constructor(root: string, limit: number) {
		this.#root = root;
		this.#limit = limit;
	}

	run(modules: readonly string[]) {
		for (const directory of modules) this.#queue.push([directory, "modules"]);
		for (let next = this.#queue.shift(); next !== undefined; next = this.#queue.shift()) this.#enter(...next);
	}

	entries(): InstallEntry[] {
		return [...this.#entries].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, entry]) => entry);
	}

	outside(): string[] {
		return [...this.#outside].sort();
	}

	// A directory's place beneath the root, with `/` between its parts on every platform.
	#place(directory: string): string {
		return relative(this.#root, directory).split(sep).join("/");
	}

	#add(...entry: string[]) {
		this.#entries.set(canonicalJson(entry), entry);
	}

	#beneath(directory: string): boolean {
		const path = relative(this.#root, directory);
		return !path.startsWith("..") && !isAbsolute(path);
	}

	#enter(path: string, mode: Mode) {
		let link: boolean;
		try {
			link = lstatSync(path).isSymbolicLink();
		} catch {
			throw new InstalledPackagesError(`Melian cannot read ${this.#place(path)} in its install.`);
		}
		if (link) this.#follow(path, mode);
		else this.#scan(path, mode);
	}

	// A link is keyed where it sits, with the real place it reaches, and never walked through: what it reaches is walked
	// where it really is, with every node_modules Node searches from there.
	#follow(path: string, mode: Mode) {
		// A node_modules that is itself a link is queued again from its own target's ancestors.
		if (this.#followed.has(path)) return;
		this.#followed.add(path);
		let target: string | undefined;
		try {
			target = realpathSync(path);
		} catch {
			target = undefined;
		}
		const at = this.#place(path);
		if (target === undefined) {
			this.#add(at, "links nowhere");
			return;
		}
		if (!this.#beneath(target)) {
			this.#add(at, "links outside");
			this.#outside.push(at);
			return;
		}
		this.#add(at, "links", this.#place(target));
		if (mode === "modules" || mode === "scope") this.#queue.push([target, mode]);
		// A linked package's own files are no release, as a workspace package's are not, so only its manifest is keyed.
		if (mode === "package") this.#add(this.#place(target), ...this.#release(target));
		for (const directory of ancestors(target)) {
			if (!this.#beneath(directory)) break;
			if (existsSync(join(directory, "node_modules")))
				this.#queue.push([join(directory, "node_modules"), "modules"]);
		}
	}

	#scan(directory: string, mode: Mode) {
		if (this.#entered.has(directory)) return;
		if (this.#entered.size >= this.#limit)
			throw new InstalledPackagesError(
				`Melian cannot key its install: it holds more than ${this.#limit} directories.`,
			);
		this.#entered.add(directory);
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			throw new InstalledPackagesError(`Melian cannot read ${this.#place(directory)} in its install.`);
		}
		if (mode === "package") this.#add(this.#place(directory), ...this.#release(directory));
		for (const entry of entries) {
			const path = join(directory, entry.name);
			const slot = (mode === "modules" || mode === "scope") && !entry.name.startsWith(".");
			const child: Mode =
				slot && mode === "modules" && entry.name.startsWith("@")
					? "scope"
					: slot
						? "package"
						: entry.name === "node_modules"
							? "modules"
							: "tree";
			if (entry.isSymbolicLink()) this.#follow(path, child);
			else if (entry.isDirectory()) this.#scan(path, child);
		}
	}

	// What a package directory holds: its manifest's name and version, or that it has none, since Node can still load it.
	#release(directory: string): string[] {
		if (!existsSync(join(directory, "package.json"))) return ["no manifest"];
		let manifest: { name?: unknown; version?: unknown };
		try {
			manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as typeof manifest;
		} catch {
			throw new InstalledPackagesError(`Melian cannot read the installed package at ${this.#place(directory)}.`);
		}
		const name = typeof manifest.name === "string" ? manifest.name : "";
		const version = typeof manifest.version === "string" ? manifest.version : "";
		return ["release", name, version];
	}
}
