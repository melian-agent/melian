import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
	it("lists each root and every package beneath it, as name@version, sorted", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { zod: "^4", sdk: "^2" } });
		install("zod", { name: "zod", version: "4.0.0" });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@2.0.0", "zod@4.0.0"]);
	});

	it("resolves each package as Node does, from the package that needs it", () => {
		install("pi/node_modules/sdk", { name: "sdk", version: "3.0.0" });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@3.0.0"]);
	});

	it("lists two copies of one release once, and two releases of one package apiece", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2", tool: "^1" } });
		install("tool", { name: "tool", version: "1.0.0", dependencies: { sdk: "^2" } });
		install("tool/node_modules/sdk", { name: "sdk", version: "2.0.0" });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@2.0.0", "tool@1.0.0"]);
		install("tool/node_modules/sdk", { name: "sdk", version: "2.1.0" });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@2.0.0", "sdk@2.1.0", "tool@1.0.0"]);
	});

	it("ends on a cycle", () => {
		install("sdk", { name: "sdk", version: "2.0.0", dependencies: { pi: "^1" } });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it("records a declared peer that is not installed, and the release that wants it", () => {
		install("sdk", { name: "sdk", version: "2.0.0", peerDependencies: { undici: "^7" } });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@2.0.0", "undici absent, a peer of sdk@2.0.0"]);
	});

	it("records a peer that is installed, and walks beneath it", () => {
		install("sdk", { name: "sdk", version: "2.0.0", peerDependencies: { undici: "^7" } });
		install("undici", { name: "undici", version: "7.1.0", dependencies: { ws: "^8" } });
		install("ws", { name: "ws", version: "8.0.0" });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@2.0.0", "undici@7.1.0", "ws@8.0.0"]);
	});

	it("leaves out an optional dependency that is not installed, as npm leaves out one its platform refuses", () => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2" }, optionalDependencies: { fsx: "1" } });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it("walks an optional dependency that is installed", () => {
		install("pi", { name: "pi", version: "1.1.0", optionalDependencies: { sdk: "^2" } });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it.each(["os", "cpu"])("leaves out a package whose manifest declares %s, and what it needs", (field) => {
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2" }, optionalDependencies: { bin: "1" } });
		install("bin", { name: "bin", version: "1.0.0", [field]: ["linux"], dependencies: { helper: "1" } });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it("leaves out @types packages, installed or not, since they never run", () => {
		install("pi", {
			name: "pi",
			version: "1.1.0",
			dependencies: { sdk: "^2", "@types/node": "^24", "@types/gone": "1" },
		});
		install("@types/node", { name: "@types/node", version: "24.0.0" });
		expect(installedPackages(roots)).toEqual(["pi@1.1.0", "sdk@2.0.0"]);
	});

	it("keys a dependency named in more than one field by the strictest", () => {
		install("pi", {
			name: "pi",
			version: "1.1.0",
			dependencies: { sdk: "^2" },
			peerDependencies: { sdk: "^2", extra: "1" },
			optionalDependencies: { extra: "1" },
		});
		expect(installedPackages(roots)).toEqual(["extra absent, a peer of pi@1.1.0", "pi@1.1.0", "sdk@2.0.0"]);
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
			createHash("sha256").update("pi@1.1.0\nsdk@2.0.0\nundici absent, a peer of sdk@2.0.0\n").digest("hex"),
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

	it("moves when an optional peer appears", () => {
		install("sdk", { name: "sdk", version: "2.0.0", peerDependencies: { undici: "^7" } });
		const before = installedPackagesDigest(roots);
		install("undici", { name: "undici", version: "7.1.0" });
		expect(installedPackagesDigest(roots)).not.toBe(before);
	});

	it("holds from one platform to another, since the parent's version stands for its platform builds", () => {
		const builds = { "bin-linux": "1", "bin-darwin": "1" };
		install("pi", { name: "pi", version: "1.1.0", dependencies: { sdk: "^2" }, optionalDependencies: builds });
		install("bin-linux", { name: "bin-linux", version: "1.0.0", os: ["linux"] });
		const linux = installedPackagesDigest(roots);
		rmSync(join(scratch, "node_modules/bin-linux"), { recursive: true });
		install("bin-darwin", { name: "bin-darwin", version: "1.0.0", os: ["darwin"] });
		expect(installedPackagesDigest(roots)).toBe(linux);
	});
});
