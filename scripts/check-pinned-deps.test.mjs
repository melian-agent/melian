import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findUnpinned, readManifests } from "./check-pinned-deps.mjs";

const manifest = (path, json) => ({ path, json });
const root = manifest("package.json", { name: "root", devDependencies: { typescript: "7.0.2" } });

describe("findUnpinned", () => {
	it("accepts exact versions and prereleases", () => {
		const pkg = manifest("packages/a/package.json", { name: "@w/a", dependencies: { x: "1.2.3", y: "1.0.0-rc.1" } });
		expect(findUnpinned({ root, packages: [pkg] })).toEqual([]);
	});

	it("rejects ranges", () => {
		const pkg = manifest("packages/a/package.json", { name: "@w/a", dependencies: { x: "^1.2.3" } });
		expect(findUnpinned({ root, packages: [pkg] })).toEqual([
			'packages/a/package.json: dependencies.x is "^1.2.3", expected an exact version',
		]);
	});

	it("accepts * for a workspace package", () => {
		const a = manifest("packages/a/package.json", { name: "@w/a" });
		const b = manifest("packages/b/package.json", { name: "@w/b", dependencies: { "@w/a": "*" } });
		expect(findUnpinned({ root, packages: [a, b] })).toEqual([]);
	});

	it("rejects * for a registry package", () => {
		const pkg = manifest("packages/a/package.json", { name: "@w/a", dependencies: { "left-pad": "*" } });
		expect(findUnpinned({ root, packages: [pkg] })).toEqual([
			'packages/a/package.json: dependencies.left-pad is "*", expected an exact version',
		]);
	});

	it("rejects the workspace: protocol, which npm does not support", () => {
		const a = manifest("packages/a/package.json", { name: "@w/a" });
		const b = manifest("packages/b/package.json", { name: "@w/b", dependencies: { "@w/a": "workspace:*" } });
		expect(findUnpinned({ root, packages: [a, b] })).toHaveLength(1);
	});
});

describe("readManifests", () => {
	let dir;
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("skips files and directories without a manifest", () => {
		dir = mkdtempSync(join(tmpdir(), "pinned-deps-"));
		writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "root" }));
		mkdirSync(join(dir, "packages", "a"), { recursive: true });
		writeFileSync(join(dir, "packages", "a", "package.json"), JSON.stringify({ name: "@w/a" }));
		mkdirSync(join(dir, "packages", "empty"));
		writeFileSync(join(dir, "packages", ".DS_Store"), "");
		expect(readManifests(dir).packages.map((pkg) => pkg.json.name)).toEqual(["@w/a"]);
	});
});
