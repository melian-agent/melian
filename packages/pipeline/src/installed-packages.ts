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
	/** The places that show a layout other than npm's, such as Yarn's Plug'n'Play map, each of which leaves it unidentified. */
	readonly unrecognised: readonly string[];

	private constructor(entries: readonly InstallEntry[], outside: readonly string[], unrecognised: readonly string[]) {
		this.entries = entries;
		this.outside = outside;
		this.unrecognised = unrecognised;
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
		return new Install(walk.entries(), walk.outside(), walk.unrecognised(start));
	}

	/** Whether nothing links out of the root and its layout is npm's, so a run keyed by the install may stand for another. */
	get identified(): boolean {
		return this.outside.length === 0 && this.unrecognised.length === 0;
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
	readonly #entered = new Map<string, Mode>();
	readonly #followed = new Set<string>();
	readonly #packages = new Set<string>();
	readonly #odd: string[] = [];
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

	// Melian does not read Yarn's Plug'n'Play map, and a directory named as an archive is one Yarn's patched fs opened. A
	// directory reached as two kinds of place, or a module beneath a node_modules that no keyed package holds, was placed by
	// a layout the walk does not know.
	unrecognised(start: string): string[] {
		const found = [...this.#odd];
		for (const directory of ancestors(start))
			for (const map of [".pnp.cjs", ".pnp.loader.mjs"])
				if (existsSync(join(directory, map))) found.push(this.#shown(join(directory, map)));
		if (start.split(sep).some((part) => part.endsWith(".zip"))) found.push(this.#shown(start));
		if (
			this.#place(start).split("/").includes("node_modules") &&
			!ancestors(start).some((directory) => this.#packages.has(directory))
		)
			found.push(this.#place(start));
		return [...new Set(found)].sort();
	}

	// A directory's place beneath the root, with `/` between its parts on every platform.
	#place(directory: string): string {
		return relative(this.#root, directory).split(sep).join("/");
	}

	#add(...entry: string[]) {
		this.#entries.set(canonicalJson(entry), entry);
	}

	#shown(path: string): string {
		return this.#beneath(path) ? this.#place(path) : path;
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
		if (mode === "package") {
			this.#packages.add(target);
			this.#add(this.#place(target), ...this.#release(target));
		}
		for (const directory of ancestors(target)) {
			if (!this.#beneath(directory)) break;
			if (existsSync(join(directory, "node_modules")))
				this.#queue.push([join(directory, "node_modules"), "modules"]);
		}
	}

	#scan(directory: string, mode: Mode) {
		const seen = this.#entered.get(directory);
		// A directory npm lays out is one kind of place, so one reached as two, as a linked scope over a package is, is not.
		if (seen !== undefined && seen !== mode) this.#odd.push(this.#place(directory));
		if (seen !== undefined) return;
		if (this.#entered.size >= this.#limit)
			throw new InstalledPackagesError(
				`Melian cannot key its install: it holds more than ${this.#limit} directories.`,
			);
		this.#entered.set(directory, mode);
		if (directory.endsWith(".zip")) this.#odd.push(this.#place(directory));
		let entries: Dirent[];
		try {
			entries = readdirSync(directory, { withFileTypes: true });
		} catch {
			// A place the walk cannot read may hold anything, so the install it is in stands for no other.
			this.#odd.push(this.#place(directory));
			return;
		}
		if (mode === "package") {
			this.#packages.add(directory);
			this.#add(this.#place(directory), ...this.#release(directory));
		}
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

	// A package directory's whole manifest, since `exports`, `main` and `type` change what runs at one version, or that
	// it has none, since Node can still load it. Its bytes, unparsed, since Node strips a byte-order mark JSON refuses.
	#release(directory: string): string[] {
		if (!existsSync(join(directory, "package.json"))) return ["no manifest"];
		try {
			return [
				"manifest",
				createHash("sha256")
					.update(readFileSync(join(directory, "package.json")))
					.digest("hex"),
			];
		} catch {
			this.#odd.push(this.#place(directory));
			return ["unreadable manifest"];
		}
	}
}
