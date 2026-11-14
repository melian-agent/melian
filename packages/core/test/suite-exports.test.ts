import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openSource, type SourceReader } from "../src/source.ts";
import { SuiteExports } from "../src/suite-exports.ts";

const testing = { "./testing": { "@melian-agent/source": "./src/testing.ts", default: "./dist/testing.js" } };
const exported = "packages/core/src/testing.ts";
const neighbour = "packages/core/src/record.ts";
const roots: string[] = [];
const gitEnv = {
	...process.env,
	GIT_CONFIG_COUNT: "0",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_AUTHOR_NAME: "Fixture",
	GIT_AUTHOR_EMAIL: "fixture@example.test",
	GIT_COMMITTER_NAME: "Fixture",
	GIT_COMMITTER_EMAIL: "fixture@example.test",
};

// Writes each path's content, a string as it stands and anything else as JSON.
function repository(files: Record<string, unknown>): string {
	const dir = mkdtempSync(join(tmpdir(), "melian-suite-exports-"));
	roots.push(dir);
	for (const [path, content] of Object.entries(files)) {
		mkdirSync(join(dir, path, ".."), { recursive: true });
		writeFileSync(join(dir, path), typeof content === "string" ? content : JSON.stringify(content));
	}
	return dir;
}

async function suitesIn(dir: string, files = [exported, neighbour]): Promise<SuiteExports> {
	return SuiteExports.read(await openSource(dir, { kind: "worktree" }), files);
}

// A source that answers only the paths it holds, and records every question it was asked.
function recordingSource(files: Record<string, string>) {
	const calls: string[] = [];
	const source = {
		exists: async (path: string) => {
			calls.push(`exists ${path}`);
			return path in files ? "file" : undefined;
		},
		readText: async (path: string) => {
			calls.push(`read ${path}`);
			return files[path];
		},
	} as unknown as SourceReader;
	return { calls, source };
}

afterEach(() => {
	for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("SuiteExports", () => {
	it("accepts the file a package exports as ./testing under the source condition", async () => {
		const suites = await suitesIn(repository({ "packages/core/package.json": { exports: testing } }));
		expect(suites.refusal(exported)).toBeUndefined();
	});

	it("refuses a neighbouring source file of the same package", async () => {
		const suites = await suitesIn(repository({ "packages/core/package.json": { exports: testing } }));
		expect(suites.refusal(neighbour)).toBe(
			`${neighbour} is not packages/core/package.json's ./testing export, ${exported}`,
		);
	});

	it("takes the nearest package.json above the file and never climbs past it", async () => {
		const dir = repository({
			"package.json": { exports: { "./testing": { "@melian-agent/source": `./${exported}` } } },
			"packages/core/package.json": { name: "core" },
		});
		expect((await suitesIn(dir)).refusal(exported)).toBe(
			"packages/core/package.json maps no ./testing export under @melian-agent/source",
		);
	});

	it("accepts a file the root package exports, when no nearer package.json sits above it", async () => {
		const dir = repository({
			"package.json": { exports: { "./testing": { "@melian-agent/source": `./${exported}` } } },
		});
		expect((await suitesIn(dir)).refusal(exported)).toBeUndefined();
	});

	it("refuses a file with no package.json above it", async () => {
		expect((await suitesIn(repository({ "README.md": "no packages" }))).refusal(exported)).toBe(
			`no package.json sits above ${exported}`,
		);
	});

	it.each([
		"/packages/core/src/testing.ts",
		"../packages/core/src/testing.ts",
		"./packages/core/src/testing.ts",
		"packages//core/src/testing.ts",
		"",
	])("refuses %j, which is not a path inside the repository, and reads nothing for it", async (file) => {
		const { calls, source } = recordingSource({ "packages/core/package.json": JSON.stringify({ exports: testing }) });
		const suites = await SuiteExports.read(source, [file]);
		expect(suites.refusal(file)).toBe(`${file} is not a path inside the repository`);
		expect(calls).toEqual([]);
	});

	it("reads one manifest for two files of one package, and asks only the paths on their way up", async () => {
		const { calls, source } = recordingSource({ "packages/core/package.json": JSON.stringify({ exports: testing }) });
		const suites = await SuiteExports.read(source, [exported, neighbour, "packages/core/src/deep/other.ts"]);
		expect(calls).toEqual([
			"exists packages/core/src/package.json",
			"exists packages/core/package.json",
			"read packages/core/package.json",
			"exists packages/core/src/deep/package.json",
		]);
		expect(suites.refusal(exported)).toBeUndefined();
		expect(suites.refusal(neighbour)).toMatch(/is not packages\/core\/package\.json's/);
	});

	it("reads nothing when it is asked about no file", async () => {
		const { calls, source } = recordingSource({});
		await SuiteExports.read(source, []);
		expect(calls).toEqual([]);
		const suites = await SuiteExports.at(join(tmpdir(), "melian-no-such-repository"), "f".repeat(40), []);
		expect(suites.refusal(exported)).toBe(`${exported} was not checked against any package's exports`);
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
		[
			"an object nested under the source condition",
			{ exports: { "./testing": { "@melian-agent/source": { import: "./src/testing.ts" } } } },
		],
		["a list of conditions", { exports: { "./testing": [{ "@melian-agent/source": "./src/testing.ts" }] } }],
		["exports as a string", { exports: "./src/index.ts" }],
		["a null manifest", "null"],
		["exports as null", { exports: null }],
		["./testing as null", { exports: { "./testing": null } }],
	])("refuses a package with %s", async (_name, manifest) => {
		const suites = await suitesIn(repository({ "packages/core/package.json": manifest }));
		expect(suites.refusal(exported)).toBe(
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
			const dir = repository({
				"packages/core/package.json": { exports: { "./testing": { "@melian-agent/source": target } } },
			});
			const reason = `packages/core/package.json maps ./testing to ${JSON.stringify(target)}, which is not a plain relative path inside the package`;
			const suites = await suitesIn(dir);
			expect(suites.refusal(neighbour)).toBe(reason);
			expect(suites.refusal(exported)).toBe(reason);
		},
	);

	it.each(["import", "default", "node", "types"])(
		"refuses a ./testing export that lists %s before the source condition",
		async (condition) => {
			const conditions = { [condition]: "./dist/testing.js", "@melian-agent/source": "./src/testing.ts" };
			const suites = await suitesIn(
				repository({ "packages/core/package.json": { exports: { "./testing": conditions } } }),
			);
			expect(suites.refusal(exported)).toBe(
				`packages/core/package.json lists ${condition} before @melian-agent/source under ./testing, and Melian accepts the source condition only as the first key`,
			);
		},
	);

	it.each([
		["a subpath pattern", "./*"],
		["a key that is not a subpath", "import"],
		["a key that only starts with a dot", ".testing"],
	])("refuses exports that hold %s beside ./testing", async (_name, key) => {
		const exports = { [key]: "./src/other.ts", "./testing": { "@melian-agent/source": "./src/testing.ts" } };
		const suites = await suitesIn(repository({ "packages/core/package.json": { exports } }));
		expect(suites.refusal(exported)).toBe(
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
		const suites = await suitesIn(repository({ "packages/core/package.json": { exports } }));
		expect(suites.refusal(exported)).toBeUndefined();
	});

	it("refuses a package whose package.json does not parse, and names why", async () => {
		const suites = await suitesIn(repository({ "packages/core/package.json": "{ not json" }));
		expect(suites.refusal(exported)).toMatch(/^cannot read packages\/core\/package\.json: .*JSON/);
	});

	it("refuses a package whose package.json is a symlink", async () => {
		const dir = repository({ "packages/real/package.json": { exports: testing } });
		mkdirSync(join(dir, "packages/core"), { recursive: true });
		symlinkSync(join(dir, "packages/real/package.json"), join(dir, "packages/core/package.json"));
		expect((await suitesIn(dir)).refusal(exported)).toMatch(/^cannot read packages\/core\/package\.json: .*symlink/);
	});

	it.each([
		[1024 * 1024, undefined],
		[1024 * 1024 + 1, /^cannot read packages\/core\/package\.json: .*1048577 bytes; the limit is 1048576$/],
	])("reads a package.json of %i bytes against the 1 MiB bound", async (size, reason) => {
		const text = JSON.stringify({ exports: testing });
		const suites = await suitesIn(
			repository({ "packages/core/package.json": text + " ".repeat(size - Buffer.byteLength(text)) }),
		);
		const refusal = suites.refusal(exported);
		if (reason === undefined) expect(refusal).toBeUndefined();
		else expect(refusal).toMatch(reason);
	});

	it("refuses a package whose package.json is gone by the time it is read", async () => {
		const source = { exists: async () => "file", readText: async () => undefined } as unknown as SourceReader;
		expect((await SuiteExports.read(source, [exported])).refusal(exported)).toBe(
			"packages/core/src/package.json does not exist",
		);
	});

	it("lets a failure that is neither a read nor a parse failure through", async () => {
		const broken = new TypeError("the source broke");
		const source = {
			exists: async () => "file",
			readText: async () => Promise.reject(broken),
		} as unknown as SourceReader;
		await expect(SuiteExports.read(source, [exported])).rejects.toBe(broken);
	});

	it("says that a file it was never asked about was not checked", async () => {
		const suites = await suitesIn(repository({ "packages/core/package.json": { exports: testing } }), [exported]);
		expect(suites.refusal(neighbour)).toBe(`${neighbour} was not checked against any package's exports`);
	});

	it("reads the exports at a commit, never the working copy, from any directory of the repository", async () => {
		const dir = repository({ "packages/core/package.json": { exports: testing } });
		const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8", env: gitEnv }).trim();
		git("init", "--quiet", "-b", "main");
		git("add", "-A");
		git("commit", "--quiet", "-m", "head");
		const head = git("rev-parse", "HEAD");
		writeFileSync(
			join(dir, "packages/core/package.json"),
			JSON.stringify({ exports: { "./testing": { "@melian-agent/source": "./src/record.ts" } } }),
		);
		for (const from of [dir, join(dir, "packages/core")]) {
			const suites = await SuiteExports.at(from, head, [exported, neighbour]);
			expect(suites.refusal(exported)).toBeUndefined();
			expect(suites.refusal(neighbour)).toBe(
				`${neighbour} is not packages/core/package.json's ./testing export, ${exported}`,
			);
		}
	});

	it("refuses every file when the commit cannot be read", async () => {
		const dir = repository({ "packages/core/package.json": { exports: testing } });
		execFileSync("git", ["init", "--quiet"], { cwd: dir, env: gitEnv });
		const missing = "f".repeat(40);
		const suites = await SuiteExports.at(dir, missing, [exported, neighbour]);
		for (const file of [exported, neighbour])
			expect(suites.refusal(file)).toMatch(new RegExp(`^cannot read the exports at ${missing}: `));
	});

	it("refuses every file when the directory is in no repository", async () => {
		const dir = repository({ "packages/core/package.json": { exports: testing } });
		const suites = await SuiteExports.at(dir, "f".repeat(40), [exported]);
		expect(suites.refusal(exported)).toBe(
			`cannot read the exports at ${"f".repeat(40)}: fatal: not a git repository (or any of the parent directories): .git`,
		);
	});

	it("refuses every file when git cannot start in the directory", async () => {
		const suites = await SuiteExports.at(join(tmpdir(), "melian-no-such-directory"), "f".repeat(40), [exported]);
		expect(suites.refusal(exported)).toMatch(/^cannot read the exports at f{40}: \S/);
	});

	it("reads this repository's own exports", async () => {
		const harness = "packages/pipeline/src/harness.ts";
		const suites = await suitesIn(join(import.meta.dirname, "../../.."), [
			"packages/pipeline/src/testing.ts",
			harness,
		]);
		expect(suites.refusal("packages/pipeline/src/testing.ts")).toBeUndefined();
		expect(suites.refusal(harness)).toMatch(/is not packages\/pipeline\/package\.json's/);
	});
});
