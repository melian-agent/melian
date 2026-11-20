import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	Install,
	type InstallEntry,
	InstalledPackagesError,
	maxInstallDirectories,
} from "../src/installed-packages.ts";

let scratch: string;
// The module the install is read from, as Melian reads its own from its own module.
let from: string;

// A manifest at `node_modules/<path>`, where a nested path such as `a/node_modules/b` installs `b` beneath `a`.
const install = (path: string, manifest: Record<string, unknown> | string) => {
	const directory = join(scratch, "node_modules", path);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
};

const read = (limit?: number) => Install.read(from, limit);
// The entry a package directory at `place` beneath the install root records: its manifest's bytes, hashed.
const manifest = (place: string): InstallEntry => [
	place,
	"manifest",
	createHash("sha256")
		.update(readFileSync(join(scratch, place, "package.json")))
		.digest("hex"),
];
const digest = () => read().digest;

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "melian-installed-packages-"));
	writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "melian-app", version: "1.0.0" }));
	writeFileSync(join(scratch, "main.js"), "");
	from = pathToFileURL(join(scratch, "main.js")).href;
	install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2" } });
	install("sdk", { name: "sdk", version: "2.0.0" });
	install("unrelated", { name: "unrelated", version: "1.0.0" });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

const failure = (run: () => unknown) => {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(InstalledPackagesError);
		return (error as InstalledPackagesError).message;
	}
	throw new Error("expected a failure");
};

// A workspace package beneath the install root, linked into its `node_modules` as npm links one.
const workspace = (name: string) => {
	const directory = join(scratch, "packages", name);
	mkdirSync(join(directory, "src"), { recursive: true });
	writeFileSync(join(directory, "package.json"), JSON.stringify({ name: `@app/${name}`, version: "0.0.0" }));
	writeFileSync(join(directory, "src", "index.js"), "");
	mkdirSync(join(scratch, "node_modules", "@app"), { recursive: true });
	symlinkSync(join("..", "..", "packages", name), join(scratch, "node_modules", "@app", name));
	return directory;
};

// A package installed beneath a workspace package's own node_modules.
const nest = (directory: string, name: string, version = "1.0.0") => {
	mkdirSync(join(directory, "node_modules", name), { recursive: true });
	writeFileSync(join(directory, "node_modules", name, "package.json"), JSON.stringify({ name, version }));
};

describe("Install.read", () => {
	it("lists every copy beneath the root as its place and release, sorted, whether or not anything imports it", () => {
		expect(read().entries).toEqual([
			manifest("node_modules/pi"),
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
		]);
	});

	it("reads the module by its path as by its file URL", () => {
		expect(Install.read(join(scratch, "main.js")).entries).toEqual(read().entries);
	});

	it("lists a scoped package at its place, and the scope as none", () => {
		install("@scope/tool", { name: "@scope/tool", version: "3.0.0" });
		expect(read().entries).toEqual([
			manifest("node_modules/@scope/tool"),
			manifest("node_modules/pi"),
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
		]);
	});

	it("lists each copy of one release at its own place", () => {
		install("pi/node_modules/sdk", { name: "sdk", version: "2.0.0" });
		expect(read().entries).toEqual([
			manifest("node_modules/pi"),
			manifest("node_modules/pi/node_modules/sdk"),
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
		]);
	});

	it("moves when two packages swap which release of a shared dependency each resolves", () => {
		install("a/node_modules/parser", { name: "parser", version: "1.1.0" });
		install("b/node_modules/parser", { name: "parser", version: "1.2.0" });
		const before = digest();
		install("a/node_modules/parser", { name: "parser", version: "1.2.0" });
		install("b/node_modules/parser", { name: "parser", version: "1.1.0" });
		expect(digest()).not.toBe(before);
	});

	it("moves when two copies of one release swap which release of a dependency each resolves", () => {
		install("a/node_modules/shared", { name: "shared", version: "1.0.0" });
		install("b/node_modules/shared", { name: "shared", version: "1.0.0" });
		install("a/node_modules/shared/node_modules/parser", { name: "parser", version: "1.0.0" });
		install("b/node_modules/shared/node_modules/parser", { name: "parser", version: "2.0.0" });
		const before = digest();
		install("a/node_modules/shared/node_modules/parser", { name: "parser", version: "2.0.0" });
		install("b/node_modules/shared/node_modules/parser", { name: "parser", version: "1.0.0" });
		expect(digest()).not.toBe(before);
	});

	it("moves when a package nested beneath a workspace package is hoisted, as Node searches both from the module", () => {
		const pipeline = workspace("pipeline");
		from = pathToFileURL(join(pipeline, "src", "index.js")).href;
		rmSync(join(scratch, "node_modules", "pi"), { recursive: true });
		nest(pipeline, "pi", "1.1.0");
		const nested = read();
		expect(nested.entries).toEqual([
			["node_modules/@app/pipeline", "links", "packages/pipeline"],
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
			manifest("packages/pipeline"),
			manifest("packages/pipeline/node_modules/pi"),
		]);
		rmSync(join(pipeline, "node_modules"), { recursive: true });
		install("pi", { name: "pi", version: "1.1.0" });
		expect(digest()).not.toBe(nested.digest);
	});

	it("moves when a nested package's own dependency is hoisted out of the workspace package", () => {
		const pipeline = workspace("pipeline");
		from = pathToFileURL(join(pipeline, "src", "index.js")).href;
		nest(pipeline, "pi");
		nest(pipeline, "tool");
		const before = digest();
		rmSync(join(pipeline, "node_modules", "tool"), { recursive: true });
		install("tool", { name: "tool", version: "1.0.0" });
		expect(digest()).not.toBe(before);
	});

	it("keys the node_modules of a workspace package another links to, though the module is not in it", () => {
		nest(workspace("core"), "yaml", "2.0.0");
		expect(read().entries).toEqual([
			["node_modules/@app/core", "links", "packages/core"],
			manifest("node_modules/pi"),
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
			manifest("packages/core"),
			manifest("packages/core/node_modules/yaml"),
		]);
	});

	it("moves when two links swap which release each resolves, though the real places hold", () => {
		for (const [store, version] of [
			["sdk-one", "2.0.0"],
			["sdk-two", "2.1.0"],
		] as const) {
			mkdirSync(join(scratch, "store", store), { recursive: true });
			writeFileSync(join(scratch, "store", store, "package.json"), JSON.stringify({ name: "sdk", version }));
		}
		const layout = (one: string, two: string) => {
			for (const [parent, store] of [
				["a", one],
				["b", two],
			] as const) {
				rmSync(join(scratch, "node_modules", parent), { recursive: true, force: true });
				mkdirSync(join(scratch, "node_modules", parent, "node_modules"), { recursive: true });
				symlinkSync(join(scratch, "store", store), join(scratch, "node_modules", parent, "node_modules", "sdk"));
			}
			return read();
		};
		const before = layout("sdk-one", "sdk-two");
		expect(before.entries).toEqual([
			["node_modules/a", "no manifest"],
			["node_modules/a/node_modules/sdk", "links", "store/sdk-one"],
			["node_modules/b", "no manifest"],
			["node_modules/b/node_modules/sdk", "links", "store/sdk-two"],
			manifest("node_modules/pi"),
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
			manifest("store/sdk-one"),
			manifest("store/sdk-two"),
		]);
		expect(layout("sdk-two", "sdk-one").digest).not.toBe(before.digest);
	});

	it("moves when a node_modules made by hand inside a package's own directory changes", () => {
		install("pi/cjs/node_modules/sdk", { name: "sdk", version: "2.0.0" });
		const before = read();
		expect(before.entries).toContainEqual(manifest("node_modules/pi/cjs/node_modules/sdk"));
		install("pi/cjs/node_modules/sdk", { name: "sdk", version: "3.0.0" });
		expect(digest()).not.toBe(before.digest);
	});

	it("moves when what a platform build needs moves, though its parent pins it exactly", () => {
		install("pi", { name: "pi", version: "1.1.0", optionalDependencies: { bin: "1.0.0" } });
		install("bin", { name: "bin", version: "1.0.0", cpu: ["x64"], dependencies: { helper: "^1" } });
		install("helper", { name: "helper", version: "1.0.0" });
		const before = digest();
		install("helper", { name: "helper", version: "1.0.1" });
		expect(digest()).not.toBe(before);
	});

	it("moves when a release beneath a package's nested entry moves, though no manifest the entry names declares it", () => {
		install("inst", { name: "inst", version: "1.0.0", exports: { ".": "./dist/index.js" } });
		install("inst/dist", { type: "module", dependencies: { babel: "^7" } });
		install("inst/node_modules/babel", { name: "babel", version: "7.0.0" });
		const before = digest();
		install("inst/node_modules/babel", { name: "babel", version: "7.1.0" });
		expect(digest()).not.toBe(before);
	});

	it("moves when an alias installs another package under a name, at the same version", () => {
		const before = digest();
		install("sdk", { name: "real-sdk", version: "2.0.0" });
		expect(read().entries).toContainEqual(manifest("node_modules/sdk"));
		expect(digest()).not.toBe(before);
	});

	it("moves when a link that names no directory and a link to a directory named nowhere swap", () => {
		install("../nowhere", { name: "nowhere", version: "1.0.0" });
		const swap = (dangling: string, real: string) => {
			rmSync(join(scratch, "node_modules", dangling), { force: true });
			rmSync(join(scratch, "node_modules", real), { force: true });
			symlinkSync(join(scratch, "gone"), join(scratch, "node_modules", dangling));
			symlinkSync(join(scratch, "nowhere"), join(scratch, "node_modules", real));
			return digest();
		};
		expect(swap("foo", "bar")).not.toBe(swap("bar", "foo"));
	});

	it("moves when a space in a place shifts where its link's target begins", () => {
		mkdirSync(join(scratch, "r links s"));
		mkdirSync(join(scratch, "s"));
		mkdirSync(join(scratch, "node_modules", "pi", "lib"));
		const link = (place: string, target: string) => {
			rmSync(join(scratch, "node_modules", "pi", "lib"), { recursive: true });
			mkdirSync(join(scratch, "node_modules", "pi", "lib"));
			symlinkSync(join(scratch, target), join(scratch, "node_modules", "pi", "lib", place));
			return digest();
		};
		expect(link("q", "r links s")).not.toBe(link("q links r", "s"));
	});

	it("moves when an @ moves between a manifest's name and its version", () => {
		install("sdk", { name: "a@b", version: "c" });
		const before = digest();
		install("sdk", { name: "a", version: "b@c" });
		expect(digest()).not.toBe(before);
	});

	it("moves when a package nothing imports moves, a dev dependency's included", () => {
		const before = digest();
		install("unrelated", { name: "unrelated", version: "1.0.1" });
		expect(digest()).not.toBe(before);
	});

	it("gives one digest for one layout installed at two places, as one lockfile on two hosts does", () => {
		nest(workspace("core"), "yaml", "2.0.0");
		const here = digest();
		const other = mkdtempSync(join(tmpdir(), "melian-installed-packages-other-"));
		try {
			cpSync(scratch, join(other, "deeper", "checkout"), { recursive: true, verbatimSymlinks: true });
			expect(Install.read(join(other, "deeper", "checkout", "main.js")).digest).toBe(here);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("keys the install root at the outermost node_modules, as a global install nests its own", () => {
		install("melian", { name: "melian", version: "1.0.0" });
		install("melian/node_modules/pi", { name: "pi", version: "1.1.0" });
		writeFileSync(join(scratch, "node_modules", "melian", "bin.js"), "");
		expect(Install.read(join(scratch, "node_modules", "melian", "bin.js")).entries).toEqual([
			manifest("node_modules/melian"),
			manifest("node_modules/melian/node_modules/pi"),
			manifest("node_modules/pi"),
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
		]);
	});

	it("keys a node_modules that is itself a link, and walks it where it really is", () => {
		renameSync(join(scratch, "node_modules"), join(scratch, "modules"));
		symlinkSync(join(scratch, "modules"), join(scratch, "node_modules"));
		expect(read().entries).toEqual([
			manifest("modules/pi"),
			manifest("modules/sdk"),
			manifest("modules/unrelated"),
			["node_modules", "links", "modules"],
		]);
	});

	it("walks a linked scope's packages where they really are", () => {
		mkdirSync(join(scratch, "store", "scope", "tool"), { recursive: true });
		writeFileSync(
			join(scratch, "store", "scope", "tool", "package.json"),
			JSON.stringify({ name: "@scope/tool", version: "3.0.0" }),
		);
		symlinkSync(join(scratch, "store", "scope"), join(scratch, "node_modules", "@scope"));
		expect(read().entries).toEqual([
			["node_modules/@scope", "links", "store/scope"],
			manifest("node_modules/pi"),
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
			manifest("store/scope/tool"),
		]);
	});

	it("walks a package's linked node_modules where it really is", () => {
		mkdirSync(join(scratch, "store", "pi-modules", "sdk"), { recursive: true });
		writeFileSync(
			join(scratch, "store", "pi-modules", "sdk", "package.json"),
			JSON.stringify({ name: "sdk", version: "3.0.0" }),
		);
		symlinkSync(join(scratch, "store", "pi-modules"), join(scratch, "node_modules", "pi", "node_modules"));
		expect(read().entries).toEqual([
			manifest("node_modules/pi"),
			["node_modules/pi/node_modules", "links", "store/pi-modules"],
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
			manifest("store/pi-modules/sdk"),
		]);
	});

	it("fails, naming the place, when a scope links to a file", () => {
		mkdirSync(join(scratch, "store"));
		writeFileSync(join(scratch, "store", "file"), "");
		symlinkSync(join(scratch, "store", "file"), join(scratch, "node_modules", "@scope"));
		expect(failure(() => read())).toBe("Melian cannot read store/file in its install.");
	});

	it("keys a directory named like a scope inside a package as no package", () => {
		install("pi/lib/@inner/thing", { name: "thing", version: "1.0.0" });
		expect(read().entries).toEqual([
			manifest("node_modules/pi"),
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
		]);
	});

	it("keys a slot named like a scope inside a scope as a package", () => {
		install("@scope/@odd", { name: "@scope/@odd", version: "1.0.0" });
		expect(read().entries).toEqual([
			manifest("node_modules/@scope/@odd"),
			manifest("node_modules/pi"),
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
		]);
	});

	it("keys a link that names no directory", () => {
		symlinkSync(join(scratch, "gone"), join(scratch, "node_modules", "gone"));
		expect(read()).toMatchObject({
			entries: [
				["node_modules/gone", "links nowhere"],
				manifest("node_modules/pi"),
				manifest("node_modules/sdk"),
				manifest("node_modules/unrelated"),
			],
			identified: true,
		});
	});

	it("keys a link beneath a dotted directory, such as npm's .bin, and lists the directory as no package", () => {
		mkdirSync(join(scratch, "node_modules", ".bin"));
		writeFileSync(join(scratch, "node_modules", "pi", "cli.js"), "");
		symlinkSync(join("..", "pi", "cli.js"), join(scratch, "node_modules", ".bin", "pi"));
		mkdirSync(join(scratch, "node_modules", ".cache", "deep"), { recursive: true });
		expect(read().entries).toEqual([
			["node_modules/.bin/pi", "links", "node_modules/pi/cli.js"],
			manifest("node_modules/pi"),
			manifest("node_modules/sdk"),
			manifest("node_modules/unrelated"),
		]);
	});

	it("keys a package directory with no manifest, which Node can still load", () => {
		mkdirSync(join(scratch, "node_modules", "bare"));
		expect(read().entries).toContainEqual(["node_modules/bare", "no manifest"]);
	});

	it.each<[string, string]>([
		["no name", JSON.stringify({ version: "1.0.0" })],
		["a version that is a number", JSON.stringify({ name: "sdk", version: 2 })],
		["a fraction, which core's canonical JSON refuses", '{"name":"sdk","version":"2.0.0","weight":1.5}'],
		["a lone surrogate, which core's canonical JSON refuses", '{"name":"sdk","version":"2.0.0","note":"\\ud800"}'],
	])("keys a manifest with %s by its bytes", (_, text) => {
		install("sdk", text);
		expect(read().entries).toContainEqual([
			"node_modules/sdk",
			"manifest",
			createHash("sha256").update(text).digest("hex"),
		]);
	});

	it.each<[string, Record<string, unknown>, Record<string, unknown>]>([
		["exports", { exports: "./a.js" }, { exports: "./b.js" }],
		["main", { main: "a.js" }, { main: "b.js" }],
		["type", { type: "commonjs" }, { type: "module" }],
	])("moves when a manifest's %s changes, at one name and version", (_, before, after) => {
		install("sdk", { name: "sdk", version: "2.0.0", ...before });
		const first = digest();
		install("sdk", { name: "sdk", version: "2.0.0", ...after });
		expect(digest()).not.toBe(first);
	});

	// What the key cannot see: a file's bytes beneath a package, which the decision of 2026-11-20 leaves out.
	it.each<[string, string, string]>([
		["a patched file, as patch-package makes", "index.js", "module.exports = 2;"],
		["a postinstall script's output", "generated/config.js", "module.exports = {};"],
		["a native binary", "build/Release/sdk.node", "\u0000\u0001"],
		["another tarball a registry serves under one version", "lib/sdk.js", "export default 2;"],
	])("keeps the digest when %s changes beneath a release", (_, file, text) => {
		const path = join(scratch, "node_modules", "sdk", file);
		mkdirSync(join(path, ".."), { recursive: true });
		writeFileSync(path, "module.exports = 1;");
		const first = digest();
		writeFileSync(path, text);
		expect(digest()).toBe(first);
	});

	it("keeps the digest when a file changes in a package with no manifest", () => {
		mkdirSync(join(scratch, "node_modules", "bare"));
		writeFileSync(join(scratch, "node_modules", "bare", "index.js"), "module.exports = 1;");
		const first = digest();
		writeFileSync(join(scratch, "node_modules", "bare", "index.js"), "module.exports = 2;");
		expect(digest()).toBe(first);
	});

	it("fails, naming the place, on a manifest that is not JSON", () => {
		install("sdk", "{");
		expect(failure(() => read())).toBe("Melian cannot read the installed package at node_modules/sdk.");
	});

	it("fails, naming the module, when no node_modules holds it", () => {
		rmSync(join(scratch, "node_modules"), { recursive: true });
		expect(failure(() => read())).toBe(`Melian cannot key its install: no node_modules holds the module ${from}.`);
	});

	it("fails, naming the module, when it cannot be read", () => {
		const gone = join(scratch, "gone.js");
		expect(failure(() => Install.read(gone))).toBe(`Melian cannot read the module ${gone} to find its install.`);
	});

	it("reads an install of as many directories as its bound, and fails one past it", () => {
		// The root's node_modules and its three packages.
		expect(read(4).entries).toHaveLength(3);
		expect(failure(() => read(3))).toBe("Melian cannot key its install: it holds more than 3 directories.");
	});

	it("bounds the walk at 50,000 directories by default", () => {
		expect(maxInstallDirectories).toBe(50_000);
	});

	describe("a link out of the install, as npm link makes", () => {
		let outside: string;
		beforeEach(() => {
			outside = mkdtempSync(join(tmpdir(), "melian-installed-packages-outside-"));
			writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "sdk", version: "2.0.0" }));
			mkdirSync(join(outside, "node_modules", "deep"), { recursive: true });
			rmSync(join(scratch, "node_modules", "sdk"), { recursive: true });
			symlinkSync(outside, join(scratch, "node_modules", "sdk"));
		});
		afterEach(() => rmSync(outside, { recursive: true, force: true }));

		it("keys the link, naming no place outside, walks nothing beneath it, and names its place", () => {
			expect(read()).toMatchObject({
				entries: [
					manifest("node_modules/pi"),
					["node_modules/sdk", "links outside"],
					manifest("node_modules/unrelated"),
				],
				outside: ["node_modules/sdk"],
				identified: false,
			});
		});

		it("sorts the places that link out, though a nearer node_modules is walked first", () => {
			mkdirSync(join(scratch, "packages", "app", "node_modules"), { recursive: true });
			writeFileSync(join(scratch, "packages", "app", "main.js"), "");
			symlinkSync(outside, join(scratch, "packages", "app", "node_modules", "late"));
			expect(Install.read(join(scratch, "packages", "app", "main.js")).outside).toEqual([
				"node_modules/sdk",
				"packages/app/node_modules/late",
			]);
		});

		it("names each place that links out once, sorted", () => {
			symlinkSync(outside, join(scratch, "node_modules", "alpha"));
			symlinkSync(outside, join(scratch, "node_modules", "pi", "beta"));
			expect(read().outside).toEqual(["node_modules/alpha", "node_modules/pi/beta", "node_modules/sdk"]);
		});

		it("gives two processes on the same install one digest", () => {
			const each = () =>
				execFileSync(
					process.execPath,
					[
						"--conditions=@melian-agent/source",
						new URL("fixtures/installed-digest.ts", import.meta.url).pathname,
						from,
					],
					{ encoding: "utf8" },
				);
			const one = each();
			expect(one).toBe(digest());
			expect(each()).toBe(one);
		});
	});

	it("identifies an install where nothing links out", () => {
		expect(read()).toMatchObject({ outside: [], identified: true });
	});

	describe("a layout other than npm's", () => {
		// A module at `place` beneath the install root, in a package directory of its own.
		const module = (place: string) => {
			mkdirSync(join(scratch, place), { recursive: true });
			writeFileSync(join(scratch, place, "main.js"), "");
			return join(scratch, place, "main.js");
		};

		it.each([".pnp.cjs", ".pnp.loader.mjs"])("leaves the install unidentified beside Yarn's map %s", (map) => {
			const entries = read().entries;
			writeFileSync(join(scratch, map), "");
			expect(read()).toMatchObject({ entries, outside: [], unrecognised: [map], identified: false });
		});

		it("finds Yarn's map in any directory above the module", () => {
			const from = module("packages/app");
			writeFileSync(join(scratch, "packages", "app", ".pnp.cjs"), "");
			expect(Install.read(from).unrecognised).toEqual(["packages/app/.pnp.cjs"]);
		});

		it("names a map above the install root by its path", () => {
			const parent = mkdtempSync(join(tmpdir(), "melian-installed-packages-pnp-"));
			try {
				writeFileSync(join(parent, ".pnp.cjs"), "");
				mkdirSync(join(parent, "app", "node_modules"), { recursive: true });
				writeFileSync(join(parent, "app", "main.js"), "");
				expect(Install.read(join(parent, "app", "main.js")).unrecognised).toEqual([
					join(realpathSync(parent), ".pnp.cjs"),
				]);
			} finally {
				rmSync(parent, { recursive: true, force: true });
			}
		});

		it("leaves the install unidentified for a module read through an archive, as Yarn's cache holds one", () => {
			install("../cache/pi.zip/node_modules/@app/pi", { name: "@app/pi", version: "1.0.0" });
			const from = module("cache/pi.zip/node_modules/@app/pi/dist");
			expect(Install.read(from)).toMatchObject({
				unrecognised: ["cache/pi.zip/node_modules/@app/pi/dist"],
				identified: false,
			});
		});

		it("leaves the install unidentified for a directory named as an archive in a walked tree", () => {
			mkdirSync(join(scratch, "node_modules", "pi", "vendor.zip"));
			expect(read()).toMatchObject({ unrecognised: ["node_modules/pi/vendor.zip"], identified: false });
		});

		it("leaves the install unidentified for a module beneath a node_modules that no package holds", () => {
			const from = module("node_modules/.store/pi");
			expect(Install.read(from)).toMatchObject({ unrecognised: ["node_modules/.store/pi"], identified: false });
		});

		it.each([
			["an installed package", "node_modules/pi/dist"],
			["a package a pnpm store holds", "node_modules/.pnpm/pi@1.1.0/node_modules/pi/dist"],
			["a directory named like an archive's", "node_modules/pi/zip"],
		])("recognises a module in %s", (_, place) => {
			if (place.includes(".pnpm")) install(".pnpm/pi@1.1.0/node_modules/pi", { name: "pi", version: "1.1.0" });
			expect(Install.read(module(place))).toMatchObject({ unrecognised: [], identified: true });
		});

		it("leaves the install unidentified for a linked scope over a directory the walk keys as a package", () => {
			install("store/pi-ai", { name: "@earendil-works/pi-ai", version: "1.1.0" });
			symlinkSync("store", join(scratch, "node_modules", "@earendil-works"));
			expect(read()).toMatchObject({ unrecognised: ["node_modules/store"], identified: false });
		});

		it("names each unrecognised place once, sorted", () => {
			mkdirSync(join(scratch, "node_modules", "pi", "vendor.zip"));
			writeFileSync(join(scratch, ".pnp.cjs"), "");
			const from = module("cache/pi.zip/node_modules/.store/pi");
			expect(Install.read(from).unrecognised).toEqual([
				".pnp.cjs",
				"cache/pi.zip/node_modules/.store/pi",
				"node_modules/pi/vendor.zip",
			]);
		});

		it("recognises a module in a package a link reaches where no walked tree keys it as one", () => {
			mkdirSync(join(scratch, "store", "node_modules", ".x", "pi"), { recursive: true });
			writeFileSync(
				join(scratch, "store", "node_modules", ".x", "pi", "package.json"),
				JSON.stringify({ name: "pi" }),
			);
			rmSync(join(scratch, "node_modules", "pi"), { recursive: true });
			symlinkSync(join("..", "store", "node_modules", ".x", "pi"), join(scratch, "node_modules", "pi"));
			expect(Install.read(module("store/node_modules/.x/pi/dist"))).toMatchObject({
				unrecognised: [],
				identified: true,
			});
		});

		it("recognises a module in a workspace package npm links", () => {
			const directory = workspace("app");
			expect(Install.read(join(directory, "src", "index.js"))).toMatchObject({ unrecognised: [], identified: true });
		});
	});

	it("is a SHA-256 over the canonical JSON of the sorted entries", () => {
		const hashed = (place: string) =>
			createHash("sha256")
				.update(readFileSync(join(scratch, place, "package.json")))
				.digest("hex");
		expect(digest()).toBe(
			createHash("sha256")
				.update(
					`[["node_modules/pi","manifest","${hashed("node_modules/pi")}"],` +
						`["node_modules/sdk","manifest","${hashed("node_modules/sdk")}"],` +
						`["node_modules/unrelated","manifest","${hashed("node_modules/unrelated")}"]]`,
				)
				.digest("hex"),
		);
	});
});
