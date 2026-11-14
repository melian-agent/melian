import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSource, type SourceReader } from "../src/source.ts";
import { SuiteExports } from "../src/suite-exports.ts";

const testing = { "./testing": { "@melian-agent/source": "./src/testing.ts", default: "./dist/testing.js" } };
const roots: string[] = [];
const absent = Symbol("absent");
const gitEnv = {
	...process.env,
	GIT_CONFIG_COUNT: "0",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.test",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.test",
};

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

// Every file a test here asks about, so a reader that reads only what its files need still answers each.
const asked = [
	"packages/core/src/testing.ts",
	"packages/core/src/record.ts",
	"packages/cli/src/testing.ts",
	"packages/core-extra/src/testing.ts",
	"packages/README.md/x.ts",
	"packages/pipeline/src/testing.ts",
	"packages/pipeline/src/harness.ts",
	"linked/core/src/testing.ts",
	"scripts/testing.ts",
	"missing/core/src/testing.ts",
];

async function suitesIn(dir: string): Promise<SuiteExports> {
	return SuiteExports.read(await openSource(dir, { kind: "worktree" }), asked);
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
		["a query", "./src/testing.ts?case/production.ts"],
		["a fragment", "./src/testing.ts#case/production.ts"],
		["a space", "./src/test ing.ts"],
		["a trailing slash", "./src/testing/"],
		["a non-ASCII letter", "./src/tésting.ts"],
		["a colon", "./src/testing.ts:x"],
	])(
		"refuses a ./testing export written as %s, which is not a plain relative path inside the package",
		async (_name, target) => {
			const suites = await suitesIn(
				workspace({ core: { exports: { "./testing": { "@melian-agent/source": target } } } }),
			);
			const reason = `packages/core/package.json maps ./testing to ${JSON.stringify(target)}, which is not a plain relative path inside the package`;
			expect(suites.refusal("packages/core/src/record.ts")).toBe(reason);
			expect(suites.refusal("packages/core/src/testing.ts")).toBe(reason);
		},
	);

	it.each(["import", "default", "node", "types"])(
		"refuses a ./testing export that lists %s before the source condition",
		async (condition) => {
			const conditions = { [condition]: "./dist/testing.js", "@melian-agent/source": "./src/testing.ts" };
			const suites = await suitesIn(workspace({ core: { exports: { "./testing": conditions } } }));
			expect(suites.refusal("packages/core/src/testing.ts")).toBe(
				`packages/core/package.json lists ${condition} before @melian-agent/source under ./testing, and Melian accepts the source condition only as the first key`,
			);
		},
	);

	it.each([
		[
			"an object nested under the source condition",
			{ "./testing": { "@melian-agent/source": { import: "./src/testing.ts" } } },
		],
		["a list of conditions", { "./testing": [{ "@melian-agent/source": "./src/testing.ts" }] }],
	])("refuses a ./testing export written as %s", async (_name, exports) => {
		const suites = await suitesIn(workspace({ core: { exports } }));
		expect(suites.refusal("packages/core/src/testing.ts")).toBe(
			"packages/core/package.json maps no ./testing export under @melian-agent/source",
		);
	});

	it.each([
		["a subpath pattern", "./*"],
		["a key that is not a subpath", "import"],
		["a key that only starts with a dot", ".testing"],
	])("refuses exports that hold %s beside ./testing", async (_name, key) => {
		const exports = { [key]: "./src/other.ts", "./testing": { "@melian-agent/source": "./src/testing.ts" } };
		const suites = await suitesIn(workspace({ core: { exports } }));
		expect(suites.refusal("packages/core/src/testing.ts")).toBe(
			`packages/core/package.json's exports hold ${JSON.stringify(key)}, which Melian does not resolve`,
		);
	});

	it("accepts the source condition as the first key with others after it", async () => {
		const conditions = {
			"@melian-agent/source": "./src/testing.ts",
			types: "./dist/testing.d.ts",
			default: "./dist/testing.js",
		};
		const exports = {
			".": { "@melian-agent/source": "./src/index.ts" },
			"./testing": conditions,
			"./package.json": "./package.json",
		};
		const suites = await suitesIn(workspace({ core: { exports } }));
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

	it.each([
		[1024 * 1024, undefined],
		[1024 * 1024 + 1, /^cannot read packages\/core\/package\.json: .*1048577 bytes; the limit is 1048576$/],
	])("reads a package.json of %i bytes against the 1 MiB bound", async (size, reason) => {
		const text = JSON.stringify({ exports: testing });
		const suites = await suitesIn(workspace({ core: text + " ".repeat(size - Buffer.byteLength(text)) }));
		const refusal = suites.refusal("packages/core/src/testing.ts");
		if (reason === undefined) expect(refusal).toBeUndefined();
		else expect(refusal).toMatch(reason);
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
			"missing/core/src/testing.ts",
		],
	])("refuses every file under %s", async (_name, root, reason, file = "packages/core/src/testing.ts") => {
		const suites = await suitesIn(workspace({ core: { exports: testing } }, root));
		expect(suites.refusal(file)).toMatch(reason);
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
		await expect(SuiteExports.read(source, asked)).rejects.toBe(broken);
	});

	it("reads the exports at a commit, never the working copy", async () => {
		const dir = workspace({ core: { exports: testing } });
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv }).trim();
		git("init", "--quiet", "-b", "main");
		git("add", "-A");
		git("commit", "--quiet", "-m", "head");
		const head = git("rev-parse", "HEAD");
		writeFileSync(
			join(dir, "packages/core/package.json"),
			JSON.stringify({ exports: { "./testing": { "@melian-agent/source": "./src/record.ts" } } }),
		);
		const suites = await SuiteExports.at(dir, head, asked);
		expect(suites.refusal("packages/core/src/testing.ts")).toBeUndefined();
		expect(suites.refusal("packages/core/src/record.ts")).toBe(
			"packages/core/src/record.ts is not packages/core's ./testing export, packages/core/src/testing.ts",
		);
	});

	it("refuses every file when the commit cannot be read", async () => {
		const dir = workspace({ core: { exports: testing } });
		execFileSync("git", ["init", "--quiet"], { cwd: dir, env: gitEnv });
		const missing = "f".repeat(40);
		expect((await SuiteExports.at(dir, missing, asked)).refusal("packages/core/src/testing.ts")).toMatch(
			new RegExp(`^cannot read the exports at ${missing}: `),
		);
	});

	it("reads nothing when it is asked about no file", async () => {
		const calls: string[] = [];
		const source = {
			readText: async (path: string) => calls.push(`read ${path}`) && undefined,
			list: async (path: string) => calls.push(`list ${path}`) && undefined,
		} as unknown as SourceReader;
		await SuiteExports.read(source, []);
		expect(calls).toEqual([]);
		const suites = await SuiteExports.at(join(tmpdir(), "melian-no-such-repository"), "f".repeat(40), []);
		expect(suites.refusal("packages/core/src/testing.ts")).toBe(
			"packages/core/src/testing.ts is in no workspace package",
		);
	});

	it("reads only the folders and manifests the asked files sit beneath", async () => {
		const calls: string[] = [];
		const files: Record<string, string> = {
			"package.json": JSON.stringify({ workspaces: ["packages/*", "tools/*", "apps/web"] }),
			"packages/core/package.json": JSON.stringify({ exports: testing }),
		};
		const source = {
			readText: async (path: string) => {
				calls.push(`read ${path}`);
				return files[path];
			},
			list: async (path: string) => {
				calls.push(`list ${path}`);
				return ["core", "cli", "pipeline"].map((name) => ({ name, kind: "directory" }));
			},
		} as unknown as SourceReader;
		const suites = await SuiteExports.read(source, ["packages/core/src/testing.ts", "packages/core/src/other.ts"]);
		expect(calls).toEqual(["read package.json", "list packages", "read packages/core/package.json"]);
		expect(suites.refusal("packages/core/src/testing.ts")).toBeUndefined();
	});

	it("reads this repository's own exports", async () => {
		const suites = await suitesIn(join(import.meta.dirname, "../../.."));
		expect(suites.refusal("packages/pipeline/src/testing.ts")).toBeUndefined();
		expect(suites.refusal("packages/pipeline/src/harness.ts")).toMatch(/is not packages\/pipeline's/);
	});
});
