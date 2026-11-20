import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	InstalledPackagesError,
	installedPackages,
	installedPackagesDigest,
	type PackageRoot,
} from "../src/installed-packages.ts";

let scratch: string;
let roots: PackageRoot[];

// A manifest at `node_modules/<path>`, where a nested path such as `a/node_modules/b` installs `b` beneath `a`.
const install = (path: string, manifest: Record<string, unknown> | string) => {
	const directory = join(scratch, "node_modules", path);
	mkdirSync(directory, { recursive: true });
	writeFileSync(join(directory, "package.json"), typeof manifest === "string" ? manifest : JSON.stringify(manifest));
};

beforeEach(() => {
	scratch = mkdtempSync(join(tmpdir(), "melian-installed-packages-"));
	writeFileSync(join(scratch, "package.json"), JSON.stringify({ name: "melian-app", version: "1.0.0" }));
	roots = [{ name: "pi", from: pathToFileURL(join(scratch, "package.json")).href, by: "melian-app" }];
	install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2" } });
	install("sdk", { name: "sdk", version: "2.0.0" });
	install("unrelated", { name: "unrelated", version: "1.0.0" });
});
afterEach(() => rmSync(scratch, { recursive: true, force: true }));

// The releases alone, without the place of each copy, for a test about which releases are keyed rather than where.
const releases = () =>
	installedPackages(roots).map((line) => (line.includes(" absent, ") ? line : line.slice(line.indexOf(" ") + 1)));

const failure = (run: () => unknown) => {
	try {
		run();
	} catch (error) {
		expect(error).toBeInstanceOf(InstalledPackagesError);
		return (error as InstalledPackagesError).message;
	}
	throw new Error("expected a failure");
};

describe("installedPackages", () => {
	it("lists each root and every copy beneath it as its place and release, sorted", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { zod: "^4", sdk: "^2" } });
		install("zod", { name: "zod", version: "4.0.0" });
		expect(installedPackages(roots)).toEqual([
			"node_modules/pi pi@1.1.0",
			"node_modules/sdk sdk@2.0.0",
			"node_modules/zod zod@4.0.0",
		]);
	});

	it("moves when two packages swap which release of a shared dependency each resolves", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { a: "^1", b: "^1" } });
		install("a", { name: "a", version: "1.0.0", dependencies: { parser: "^1" } });
		install("b", { name: "b", version: "1.0.0", dependencies: { parser: "^1" } });
		install("a/node_modules/parser", { name: "parser", version: "1.1.0" });
		install("b/node_modules/parser", { name: "parser", version: "1.2.0" });
		const before = installedPackagesDigest(roots);
		install("a/node_modules/parser", { name: "parser", version: "1.2.0" });
		install("b/node_modules/parser", { name: "parser", version: "1.1.0" });
		expect(installedPackagesDigest(roots)).not.toBe(before);
	});

	it("moves when two copies of one release swap which release of a dependency each resolves", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { a: "^1", b: "^1" } });
		install("a", { name: "a", version: "1.0.0", dependencies: { shared: "^1" } });
		install("b", { name: "b", version: "1.0.0", dependencies: { shared: "^1" } });
		install("a/node_modules/shared", { name: "shared", version: "1.0.0", dependencies: { parser: "*" } });
		install("b/node_modules/shared", { name: "shared", version: "1.0.0", dependencies: { parser: "*" } });
		install("a/node_modules/shared/node_modules/parser", { name: "parser", version: "1.0.0" });
		install("b/node_modules/shared/node_modules/parser", { name: "parser", version: "2.0.0" });
		const before = installedPackagesDigest(roots);
		install("a/node_modules/shared/node_modules/parser", { name: "parser", version: "2.0.0" });
		install("b/node_modules/shared/node_modules/parser", { name: "parser", version: "1.0.0" });
		expect(installedPackagesDigest(roots)).not.toBe(before);
	});

	it("holds when the same releases resolve the same way, named and imported in another order", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { a: "^1", b: "^1" } });
		install("a", { name: "a", version: "1.0.0", dependencies: { parser: "^1" } });
		install("b", { name: "b", version: "1.0.0", dependencies: { parser: "^1" } });
		install("parser", { name: "parser", version: "1.1.0" });
		const from = roots[0].from;
		roots = [roots[0], { name: "b", from, by: "melian-app" }];
		const before = installedPackagesDigest(roots);
		install("pi", { name: "pi", version: "1.1.0", dependencies: { b: "^1", a: "^1" } });
		roots = [roots[1], roots[0]];
		expect(installedPackagesDigest(roots)).toBe(before);
	});

	it("resolves each package as Node does, from the package that needs it", () => {
		install("pi/node_modules/sdk", { name: "sdk", version: "3.0.0" });
		expect(releases()).toEqual(["pi@1.1.0", "sdk@3.0.0"]);
	});

	it("lists each copy of one release at its own place", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2", tool: "^1" } });
		install("tool", { name: "tool", version: "1.0.0", dependencies: { sdk: "^2" } });
		install("tool/node_modules/sdk", { name: "sdk", version: "2.0.0" });
		expect(installedPackages(roots)).toEqual([
			"node_modules/pi pi@1.1.0",
			"node_modules/sdk sdk@2.0.0",
			"node_modules/tool tool@1.0.0",
			"node_modules/tool/node_modules/sdk sdk@2.0.0",
		]);
	});

	it("lists a copy two parents resolve once", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2", tool: "^1" } });
		install("tool", { name: "tool", version: "1.0.0", dependencies: { sdk: "^2" } });
		expect(installedPackages(roots)).toEqual([
			"node_modules/pi pi@1.1.0",
			"node_modules/sdk sdk@2.0.0",
			"node_modules/tool tool@1.0.0",
		]);
	});

	it("leaves out a platform build every parent that reaches it pins exactly", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2", bin: "1.0.0" } });
		install("sdk", { name: "sdk", version: "2.0.0", dependencies: { bin: "1.0.0" } });
		install("bin", { name: "bin", version: "1.0.0", cpu: ["x64"] });
		expect(installedPackages(roots)).toEqual(["node_modules/pi pi@1.1.0", "node_modules/sdk sdk@2.0.0"]);
	});

	it("gives one digest for one layout installed at two places, as one lockfile on two hosts does", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2", tool: "^1" } });
		install("tool", { name: "tool", version: "1.0.0", dependencies: { sdk: "^2" } });
		install("tool/node_modules/sdk", { name: "sdk", version: "2.1.0" });
		const here = installedPackagesDigest(roots);
		const other = mkdtempSync(join(tmpdir(), "melian-installed-packages-other-"));
		try {
			cpSync(scratch, join(other, "deeper", "checkout"), { recursive: true });
			const from = pathToFileURL(join(other, "deeper", "checkout", "package.json")).href;
			expect(installedPackagesDigest([{ ...roots[0], from }])).toBe(here);
		} finally {
			rmSync(other, { recursive: true, force: true });
		}
	});

	it("keys the install root at the outermost node_modules, as a global install nests its own", () => {
		install("melian/node_modules/pi", { name: "pi", version: "1.1.0" });
		install("melian", { name: "melian", version: "1.0.0" });
		roots = [
			{
				name: "pi",
				from: pathToFileURL(join(scratch, "node_modules", "melian", "package.json")).href,
				by: "melian",
			},
		];
		expect(installedPackages(roots)).toEqual(["node_modules/melian/node_modules/pi pi@1.1.0"]);
	});

	it("takes the install root from every root, when npm nests the first beneath a workspace package and hoists the next", () => {
		rmSync(join(scratch, "node_modules", "pi"), { recursive: true });
		const workspace = join(scratch, "packages", "pipeline");
		mkdirSync(join(workspace, "node_modules", "pi"), { recursive: true });
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ name: "@melian-agent/pipeline", version: "0.0.0" }),
		);
		writeFileSync(
			join(workspace, "node_modules", "pi", "package.json"),
			JSON.stringify({ name: "pi", version: "1.1.0", dependencies: { sdk: "^2" } }),
		);
		const from = pathToFileURL(join(workspace, "package.json")).href;
		roots = [
			{ name: "pi", from, by: "@melian-agent/pipeline" },
			{ name: "sdk", from, by: "@melian-agent/pipeline" },
		];
		expect(installedPackages(roots)).toEqual([
			"node_modules/sdk sdk@2.0.0",
			"packages/pipeline/node_modules/pi pi@1.1.0",
		]);
	});

	it("takes the install root from every copy, when npm nests a root beneath a workspace package and hoists one of what it needs", () => {
		rmSync(join(scratch, "node_modules", "pi"), { recursive: true });
		const workspace = join(scratch, "packages", "pipeline");
		mkdirSync(join(workspace, "node_modules", "pi"), { recursive: true });
		mkdirSync(join(workspace, "node_modules", "tool"), { recursive: true });
		writeFileSync(
			join(workspace, "package.json"),
			JSON.stringify({ name: "@melian-agent/pipeline", version: "0.0.0" }),
		);
		writeFileSync(
			join(workspace, "node_modules", "pi", "package.json"),
			JSON.stringify({ name: "pi", version: "1.1.0", dependencies: { sdk: "^2", tool: "^1" } }),
		);
		writeFileSync(
			join(workspace, "node_modules", "tool", "package.json"),
			JSON.stringify({ name: "tool", version: "1.0.0" }),
		);
		roots = [{ name: "pi", from: pathToFileURL(join(workspace, "package.json")).href, by: "@melian-agent/pipeline" }];
		expect(installedPackages(roots)).toEqual([
			"node_modules/sdk sdk@2.0.0",
			"packages/pipeline/node_modules/pi pi@1.1.0",
			"packages/pipeline/node_modules/tool tool@1.0.0",
		]);
	});

	it("records a package reached through a link at the place it links to, and resolves beneath it from there", () => {
		rmSync(join(scratch, "node_modules", "pi"), { recursive: true });
		mkdirSync(join(scratch, "packages", "pi", "node_modules", "sdk"), { recursive: true });
		writeFileSync(
			join(scratch, "packages", "pi", "package.json"),
			JSON.stringify({ name: "pi", version: "1.1.0", dependencies: { sdk: "^2" } }),
		);
		writeFileSync(
			join(scratch, "packages", "pi", "node_modules", "sdk", "package.json"),
			JSON.stringify({ name: "sdk", version: "2.5.0" }),
		);
		symlinkSync(join("..", "packages", "pi"), join(scratch, "node_modules", "pi"));
		expect(installedPackages(roots)).toEqual(["packages/pi pi@1.1.0", "packages/pi/node_modules/sdk sdk@2.5.0"]);
	});

	it("fails, naming the package, when it resolves outside the install root", () => {
		const outside = mkdtempSync(join(tmpdir(), "melian-installed-packages-outside-"));
		try {
			writeFileSync(join(outside, "package.json"), JSON.stringify({ name: "sdk", version: "2.0.0" }));
			rmSync(join(scratch, "node_modules", "sdk"), { recursive: true });
			symlinkSync(outside, join(scratch, "node_modules", "sdk"));
			expect(failure(() => installedPackages(roots))).toBe(
				"Melian cannot key the installed package sdk, which pi@1.1.0 needs: it is not beneath the install's node_modules.",
			);
		} finally {
			rmSync(outside, { recursive: true, force: true });
		}
	});

	it("fails, naming the root, when Node finds it beneath no node_modules, as a package naming itself is", () => {
		writeFileSync(
			join(scratch, "package.json"),
			JSON.stringify({ name: "pi", version: "1.1.0", exports: "./index.js" }),
		);
		expect(failure(() => installedPackages(roots))).toBe(
			"Melian cannot key the installed package pi, which melian-app needs: it is not beneath the install's node_modules.",
		);
	});

	it("ends on a cycle", () => {
		install("sdk", { name: "sdk", version: "2.0.0", dependencies: { pi: "^1" } });
		expect(releases()).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it("records a declared peer that is not installed, and the release that wants it", () => {
		install("sdk", { name: "sdk", version: "2.0.0", peerDependencies: { undici: "^7" } });
		expect(releases()).toEqual(["pi@1.1.0", "sdk@2.0.0", "undici absent, a peer of sdk@2.0.0"]);
	});

	it("records a peer that is installed, and walks beneath it", () => {
		install("sdk", { name: "sdk", version: "2.0.0", peerDependencies: { undici: "^7" } });
		install("undici", { name: "undici", version: "7.1.0", dependencies: { ws: "^8" } });
		install("ws", { name: "ws", version: "8.0.0" });
		expect(releases()).toEqual(["pi@1.1.0", "sdk@2.0.0", "undici@7.1.0", "ws@8.0.0"]);
	});

	it("leaves out an optional dependency that is not installed, as npm leaves out one its platform refuses", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2" }, optionalDependencies: { fsx: "1" } });
		expect(releases()).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it("walks an optional dependency that is installed", () => {
		install("pi", { name: "pi", version: "1.1.0", optionalDependencies: { sdk: "^2" } });
		expect(releases()).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it.each(["os", "cpu"])(
		"leaves out a package whose manifest declares %s, pinned exactly, and what it needs",
		(field) => {
			install("pi", {
				name: "pi",
				version: "1.1.0",
				dependencies: { sdk: "^2" },
				optionalDependencies: { bin: "1.0.0" },
			});
			install("bin", { name: "bin", version: "1.0.0", [field]: ["linux"], dependencies: { helper: "1" } });
			expect(releases()).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
		},
	);

	it("leaves out a platform build its parent requires at its exact version", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2", bin: "1.0.0" } });
		install("bin", { name: "bin", version: "1.0.0", cpu: ["x64"] });
		expect(releases()).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it("keys a package its parent pins exactly when it names no platform", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "2.0.0" } });
		expect(releases()).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it("keys a platform build its parent names by a range, since the parent's version does not fix it", () => {
		install("pi", {
			name: "pi",
			version: "1.1.0",
			dependencies: { sdk: "^2" },
			optionalDependencies: { bin: "^1.0.0" },
		});
		install("bin", { name: "bin", version: "1.0.0", os: ["linux"], dependencies: { helper: "1" } });
		install("helper", { name: "helper", version: "1.0.0" });
		expect(releases()).toEqual(["bin@1.0.0", "helper@1.0.0", "pi@1.1.0", "sdk@2.0.0"]);
	});

	it("keys a platform build a producer imports itself, which no parent pins", () => {
		install("pi", { name: "pi", version: "1.1.0", os: ["linux"], dependencies: { sdk: "^2" } });
		expect(releases()).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it.each([
		["the root first", ["bin", "pi"]],
		["the pinning parent first", ["pi", "bin"]],
	])("keys a platform build a producer imports when a parent also pins it exactly, with %s", (_, order) => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { bin: "1.0.0" } });
		install("bin", { name: "bin", version: "1.0.0", os: ["linux"], dependencies: { sdk: "^2" } });
		const from = roots[0].from;
		roots = order.map((name) => ({ name, from, by: "melian-app" }));
		expect(installedPackages(roots)).toEqual([
			"node_modules/bin bin@1.0.0",
			"node_modules/pi pi@1.1.0",
			"node_modules/sdk sdk@2.0.0",
		]);
	});

	it.each([
		["the exact pin first", { bin: "1.0.0", sdk: "^2" }],
		["the range first", { sdk: "^2", bin: "1.0.0" }],
	])("keys a platform build another parent names by a range, with %s", (_, dependencies) => {
		install("pi", { name: "pi", version: "1.1.0", dependencies });
		install("sdk", { name: "sdk", version: "2.0.0", dependencies: { bin: "^1" } });
		install("bin", { name: "bin", version: "1.0.0", cpu: ["x64"] });
		expect(installedPackages(roots)).toEqual([
			"node_modules/bin bin@1.0.0",
			"node_modules/pi pi@1.1.0",
			"node_modules/sdk sdk@2.0.0",
		]);
	});

	it("leaves out @types packages, installed or not, since they never run", () => {
		install("pi", {
			name: "pi",
			version: "1.1.0",
			dependencies: { sdk: "^2", "@types/node": "^24", "@types/gone": "1" },
		});
		install("@types/node", { name: "@types/node", version: "24.0.0" });
		expect(releases()).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it("keys a dependency named in more than one field by the strictest", () => {
		install("pi", {
			name: "pi",
			version: "1.1.0",
			dependencies: { sdk: "^2" },
			peerDependencies: { sdk: "^2", extra: "1" },
			optionalDependencies: { extra: "1" },
		});
		expect(releases()).toEqual(["extra absent, a peer of pi@1.1.0", "pi@1.1.0", "sdk@2.0.0"]);
		rmSync(join(scratch, "node_modules/sdk"), { recursive: true });
		expect(failure(() => installedPackages(roots))).toBe(
			"Melian cannot find the installed package sdk, which pi@1.1.0 needs.",
		);
	});

	it("fails, naming the root and who imports it, when a root is not installed", () => {
		rmSync(join(scratch, "node_modules/pi"), { recursive: true });
		expect(failure(() => installedPackages(roots))).toBe(
			"Melian cannot find the installed package pi, which melian-app needs.",
		);
	});

	it("fails, naming the package, when a dependency is not installed", () => {
		rmSync(join(scratch, "node_modules/sdk"), { recursive: true });
		expect(failure(() => installedPackages(roots))).toBe(
			"Melian cannot find the installed package sdk, which pi@1.1.0 needs.",
		);
	});

	it.each<[string, Record<string, unknown> | string]>([
		["a manifest that is not JSON", "{"],
		["a manifest of another name", { name: "other", version: "2.0.0" }],
		["a manifest with no version", { name: "sdk" }],
		["a manifest whose version is a number", { name: "sdk", version: 2 }],
	])("fails, naming the package, on %s", (_, manifest) => {
		install("sdk", manifest);
		expect(failure(() => installedPackages(roots))).toBe(
			"Melian cannot read the installed package sdk, which pi@1.1.0 needs.",
		);
	});

	it("lists nothing for no roots", () => {
		expect(installedPackages([])).toEqual([]);
	});
});

describe("installedPackagesDigest", () => {
	it("is a SHA-256 over the sorted lines, each ended by a newline", () => {
		install("sdk", { name: "sdk", version: "2.0.0", peerDependencies: { undici: "^7" } });
		expect(installedPackagesDigest(roots)).toBe(
			createHash("sha256")
				.update("node_modules/pi pi@1.1.0\nnode_modules/sdk sdk@2.0.0\nundici absent, a peer of sdk@2.0.0\n")
				.digest("hex"),
		);
	});

	it("moves when a version beneath a root moves", () => {
		const before = installedPackagesDigest(roots);
		install("sdk", { name: "sdk", version: "2.0.1" });
		expect(installedPackagesDigest(roots)).not.toBe(before);
	});

	it("holds when a package no root reaches moves", () => {
		const before = installedPackagesDigest(roots);
		install("unrelated", { name: "unrelated", version: "9.0.0" });
		expect(installedPackagesDigest(roots)).toBe(before);
	});

	it("moves when a platform build its parent names by a range moves", () => {
		install("pi", {
			name: "pi",
			version: "1.1.0",
			dependencies: { sdk: "^2" },
			optionalDependencies: { bin: "^1.0.0" },
		});
		install("bin", { name: "bin", version: "1.0.0", os: ["linux"] });
		const before = installedPackagesDigest(roots);
		install("bin", { name: "bin", version: "1.0.1", os: ["linux"] });
		expect(installedPackagesDigest(roots)).not.toBe(before);
	});

	it("moves when an optional peer appears", () => {
		install("sdk", { name: "sdk", version: "2.0.0", peerDependencies: { undici: "^7" } });
		const before = installedPackagesDigest(roots);
		install("undici", { name: "undici", version: "7.1.0" });
		expect(installedPackagesDigest(roots)).not.toBe(before);
	});

	it("holds from one platform to another, since the parent's exact pin stands for its platform builds", () => {
		const builds = { "bin-linux": "1.0.0", "bin-darwin": "1.0.0" };
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2" }, optionalDependencies: builds });
		install("bin-linux", { name: "bin-linux", version: "1.0.0", os: ["linux"] });
		const linux = installedPackagesDigest(roots);
		rmSync(join(scratch, "node_modules/bin-linux"), { recursive: true });
		install("bin-darwin", { name: "bin-darwin", version: "1.0.0", os: ["darwin"] });
		expect(installedPackagesDigest(roots)).toBe(linux);
	});
});
