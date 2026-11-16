import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installedVersion } from "../src/installed-version.ts";

let root: string;
let from: string;

// Installs a package under `root/node_modules/<name>`, its files given by path.
function install(name: string, files: Record<string, unknown>) {
	for (const [path, content] of Object.entries(files)) {
		const file = join(root, "node_modules", name, path);
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content));
	}
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "melian-installed-version-"));
	from = pathToFileURL(join(root, "index.js")).href;
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("installedVersion", () => {
	it("reads the version the installed package's manifest gives", () => {
		install("pi-like", { "package.json": { name: "pi-like", version: "1.2.3", main: "index.js" }, "index.js": "" });
		expect(installedVersion("pi-like", from)).toBe("1.2.3");
	});

	it("refuses a manifest that names another package, as one installed under an alias does", () => {
		install("pi-like", { "package.json": { name: "other", version: "1.2.3", main: "index.js" }, "index.js": "" });
		expect(() => installedVersion("pi-like", from)).toThrow("Melian cannot read the installed version of pi-like.");
	});

	it("refuses a manifest that gives no version as a string", () => {
		install("pi-like", { "package.json": { name: "pi-like", version: 1, main: "index.js" }, "index.js": "" });
		expect(() => installedVersion("pi-like", from)).toThrow("Melian cannot read the installed version of pi-like.");
	});
});
