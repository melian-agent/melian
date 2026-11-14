import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSource, type SourceReader } from "../src/source.ts";
import { SuiteExports } from "../src/suite-exports.ts";

const testing = { "./testing": { "@melian-agent/source": "./src/testing.ts", default: "./dist/testing.js" } };
const roots: string[] = [];
const absent = Symbol("absent");

function workspace(packages: Record<string, unknown>, root: unknown = { workspaces: ["packages/*"] }): string {
	const dir = mkdtempSync(join(tmpdir(), "melian-suite-exports-"));
	roots.push(dir);
	if (root !== absent)
		writeFileSync(join(dir, "package.json"), typeof root === "string" ? root : JSON.stringify(root));
	for (const [name, manifest] of Object.entries(packages)) {
		mkdirSync(join(dir, "packages", name), { recursive: true });
		if (manifest !== undefined)
			writeFileSync(
				join(dir, "packages", name, "package.json"),
				typeof manifest === "string" ? manifest : JSON.stringify(manifest),
			);
	}
	return dir;
}

async function suitesIn(dir: string): Promise<SuiteExports> {
	return SuiteExports.read(await openSource(dir, { kind: "worktree" }));
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SuiteExports", () => {
	it("accepts the file a workspace package exports as ./testing under the source condition", async () => {
		const suites = await suitesIn(workspace({ core: { exports: testing } }));
		expect(suites.refusal("packages/core/src/testing.ts")).toBeUndefined();
	});

	it("refuses a neighbouring source file of the same package", async () => {
		const suites = await suitesIn(workspace({ core: { exports: testing } }));
		expect(suites.refusal("packages/core/src/record.ts")).toBe(
			"packages/core/src/record.ts is not packages/core's ./testing export, packages/core/src/testing.ts",
		);
	});

	it.each([
		["no exports field", { name: "core" }],
		["exports without ./testing", { exports: { ".": { "@melian-agent/source": "./src/index.ts" } } }],
		["./testing as a plain string", { exports: { "./testing": "./src/testing.ts" } }],
		["./testing without the source condition", { exports: { "./testing": { default: "./dist/testing.js" } } }],
		[
			"the source condition as a list",
			{ exports: { "./testing": { "@melian-agent/source": ["./src/testing.ts"] } } },
		],
		["exports as a string", { exports: "./src/index.ts" }],
		["a null manifest", null],
	])("refuses a package with %s", async (_name, manifest) => {
		const suites = await suitesIn(workspace({ core: manifest }));
		expect(suites.refusal("packages/core/src/testing.ts")).toBe(
			"packages/core/package.json maps no ./testing export under @melian-agent/source",
		);
	});

	it.each([
		["a bare path", "src/record.ts"],
		["an absolute path", "/src/record.ts"],
		["a path that leaves the package and comes back", "../core/src/record.ts"],
		["a path that leaves the package", "../other/src/testing.ts"],
		["a .. segment inside the package", "./src/../src/record.ts"],
		["a . segment", "./src/./record.ts"],
		["an empty segment", "./src//record.ts"],
		["a node_modules segment", "./node_modules/x/testing.ts"],
		["a NODE_MODULES segment", "./NODE_MODULES/x/testing.ts"],
		["a percent escape", "./src/%2e%2e/record.ts"],
		["a backslash", "./src\\record.ts"],
		["only the package itself", "./"],
	])(
		"refuses a ./testing export written as %s, which Node does not resolve to one file in the package",
		async (_name, target) => {
			const suites = await suitesIn(
				workspace({ core: { exports: { "./testing": { "@melian-agent/source": target } } } }),
			);
			const reason = `packages/core/package.json maps ./testing to ${JSON.stringify(target)}, which Node does not resolve to one file in the package`;
			expect(suites.refusal("packages/core/src/record.ts")).toBe(reason);
			expect(suites.refusal("packages/core/src/testing.ts")).toBe(reason);
		},
	);

	it("refuses a ./testing export whose default condition comes before the source condition", async () => {
		const suites = await suitesIn(
			workspace({
				core: {
					exports: { "./testing": { default: "./dist/testing.js", "@melian-agent/source": "./src/testing.ts" } },
				},
			}),
		);
		expect(suites.refusal("packages/core/src/testing.ts")).toBe(
			"packages/core/package.json lists the default condition before @melian-agent/source under ./testing, so Node never reaches it",
		);
	});

	it("accepts a ./testing export whose other conditions come before the source condition", async () => {
		const suites = await suitesIn(
			workspace({
				core: {
					exports: { "./testing": { types: "./dist/testing.d.ts", "@melian-agent/source": "./src/testing.ts" } },
				},
			}),
		);
		expect(suites.refusal("packages/core/src/testing.ts")).toBeUndefined();
	});

	it("refuses a package whose package.json does not parse, and names why", async () => {
		const suites = await suitesIn(workspace({ core: "{ not json" }));
		expect(suites.refusal("packages/core/src/testing.ts")).toMatch(
			/^cannot read packages\/core\/package\.json: .*JSON/,
		);
	});

	it("refuses a package with no package.json", async () => {
		const suites = await suitesIn(workspace({ core: undefined }));
		expect(suites.refusal("packages/core/src/testing.ts")).toBe("packages/core/package.json does not exist");
	});

	it("refuses a package whose package.json is a symlink", async () => {
		const dir = workspace({ core: undefined, real: { exports: testing } });
		symlinkSync(join(dir, "packages/real/package.json"), join(dir, "packages/core/package.json"));
		expect((await suitesIn(dir)).refusal("packages/core/src/testing.ts")).toMatch(
			/^cannot read packages\/core\/package\.json: .*symlink/,
		);
	});

	it("keeps each package's answer to itself", async () => {
		const suites = await suitesIn(workspace({ core: { exports: testing }, cli: { name: "cli" } }));
		expect(suites.refusal("packages/core/src/testing.ts")).toBeUndefined();
		expect(suites.refusal("packages/cli/src/testing.ts")).toBe(
			"packages/cli/package.json maps no ./testing export under @melian-agent/source",
		);
	});

	it("refuses a file in no workspace package, including one whose path only starts with a package's name", async () => {
		const suites = await suitesIn(workspace({ core: { exports: testing } }));
		expect(suites.refusal("scripts/testing.ts")).toBe("scripts/testing.ts is in no workspace package");
		expect(suites.refusal("packages/core-extra/src/testing.ts")).toBe(
			"packages/core-extra/src/testing.ts is in no workspace package",
		);
	});

	it("reads a workspace named exactly", async () => {
		const root = workspace({ core: { exports: testing } }, { workspaces: ["packages/core"] });
		const suites = await suitesIn(root);
		expect(suites.refusal("packages/core/src/testing.ts")).toBeUndefined();
	});

	it("counts only folders under a trailing wildcard", async () => {
		const dir = workspace({ core: { exports: testing } });
		writeFileSync(join(dir, "packages/README.md"), "not a package");
		expect((await suitesIn(dir)).refusal("packages/README.md/x.ts")).toBe(
			"packages/README.md/x.ts is in no workspace package",
		);
	});

	it.each([
		["a root package.json that does not parse", "{ not json", /^cannot read the root package\.json: .*JSON/],
		["no root package.json", absent, /^the root package\.json does not exist$/],
		["a root package.json with no workspaces", { name: "melian" }, /^the root package\.json lists no workspaces$/],
		[
			"workspaces that are not a list of strings",
			{ workspaces: [1] },
			/^the root package\.json lists no workspaces$/,
		],
		[
			"workspaces that mix a string with a number",
			{ workspaces: ["packages/*", 1] },
			/^the root package\.json lists no workspaces$/,
		],
		["a null root package.json", "null", /^the root package\.json lists no workspaces$/],
		[
			"a workspace pattern Melian does not read",
			{ workspaces: ["packages/**"] },
			/^the root package\.json's workspace pattern packages\/\*\* is not one Melian reads$/,
		],
		[
			"a wildcard over a folder outside the repository",
			{ workspaces: ["../outside/*"] },
			/^the root package\.json's workspace pattern \.\.\/outside\/\* is not one Melian reads$/,
		],
		[
			"a workspace path outside the repository",
			{ workspaces: ["../packages/core"] },
			/^the root package\.json's workspace pattern \.\.\/packages\/core is not one Melian reads$/,
		],
		[
			"a workspace path spelt with a leading ./",
			{ workspaces: ["./packages/*"] },
			/^the root package\.json's workspace pattern \.\/packages\/\* is not one Melian reads$/,
		],
		[
			"a wildcard over the root",
			{ workspaces: ["/*"] },
			/^the root package\.json's workspace pattern \/\* is not one Melian reads$/,
		],
		[
			"a wildcard over a folder that is missing",
			{ workspaces: ["missing/*"] },
			/^the workspace folder missing does not exist$/,
		],
	])("refuses every file under %s", async (_name, root, reason) => {
		const suites = await suitesIn(workspace({ core: { exports: testing } }, root));
		expect(suites.refusal("packages/core/src/testing.ts")).toMatch(reason);
	});

	it("refuses every file when a wildcard's folder is a symlink, and names why", async () => {
		const dir = workspace({ core: { exports: testing } }, { workspaces: ["linked/*"] });
		symlinkSync(join(dir, "packages"), join(dir, "linked"));
		expect((await suitesIn(dir)).refusal("linked/core/src/testing.ts")).toMatch(
			/^cannot read the workspace folder linked: .*symlink/,
		);
	});

	it("lets a failure that is neither a read nor a parse failure through", async () => {
		const broken = new TypeError("the source broke");
		const source = { readText: async () => Promise.reject(broken) } as unknown as SourceReader;
		await expect(SuiteExports.read(source)).rejects.toBe(broken);
	});

	it("reads this repository's own exports", async () => {
		const suites = await suitesIn(join(import.meta.dirname, "../../.."));
		expect(suites.refusal("packages/pipeline/src/testing.ts")).toBeUndefined();
		expect(suites.refusal("packages/pipeline/src/harness.ts")).toMatch(/is not packages\/pipeline's/);
	});
});
