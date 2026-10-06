import { join } from "node:path";
import {
	type ChangedFile,
	defaultConfig,
	EnolaPolicy,
	GraphCoverage,
	GraphSnapshot,
	ToolManifest,
} from "@melian-agent/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CoverageCache } from "../src/coverage-cache.ts";
import { EnolaRun } from "../src/enola-static.ts";
import { GraphCache } from "../src/graph-cache.ts";
import { backgroundContext as context, createNodeExecutionEnv } from "../src/harness.ts";
import { Run } from "../src/static.ts";
import { ToolProvisioning } from "../src/tool-provisioning.ts";
import { commit, createRepository, removeRepository } from "./fixtures/repo.ts";
import { testTool, toolArchive } from "./fixtures/tool-archive.ts";

let repo: string;
beforeEach(() => {
	repo = createRepository();
});
afterEach(() => {
	vi.restoreAllMocks();
	removeRepository(repo);
});

async function fixture(cached = true, timeout = 30) {
	const head = commit(repo, {
		"src/a.ts": "export const Alpha = 1;\n",
		"enola/constraints/layer.yaml": "rules: []\n",
		"enola.yaml": "providers: []\n",
	});
	const bytes = toolArchive([{ name: "enola", text: "#!/bin/sh\nexit 0\n" }]);
	const { name, ...fields } = testTool(bytes);
	const tools = await ToolProvisioning.open(repo, {
		root: join(repo, "cache"),
		platform: "darwin-arm64",
		fetch: async () => new Response(bytes),
		manifest: ToolManifest.parse(JSON.stringify({ format_version: 1, tools: { [name]: fields }, misses: [] })),
	});
	const run = new Run(
		{
			repoRoot: repo,
			base: head,
			commit: head,
			env: createNodeExecutionEnv(repo),
			settings: { ...defaultConfig.static.enola, timeout },
			tool: "enola",
			tools,
		},
		context,
	);
	const artifacts: Record<string, string | undefined> = {
		"facts.jsonl": JSON.stringify({ id: "alpha", kind: "symbol", name: "Alpha", file: "src/a.ts", line: 1 }),
		"insights.json": "[]",
		"receipt.json": JSON.stringify({
			format_version: 1,
			snapshot_id: `sha256:${"a".repeat(64)}`,
			enola_version: "0.0.1",
		}),
		"check.sarif": '{"version":"2.1.0","runs":[{"results":[]}]}',
		"impact.json": JSON.stringify({
			target: "Alpha",
			by_depth: {
				"1": [
					{ name: "Caller", kind: "symbol", file: "src/caller.ts", line: 1 },
					{ name: "Changed", kind: "symbol", file: "src/a.ts", line: 1 },
					{ name: "Unlocated", kind: "symbol" },
					{ name: "NoFile", kind: "symbol", line: 1 },
					{ name: "NoLine", kind: "symbol", file: "src/caller.ts" },
				],
			},
			edges: [],
			stats: { truncated: false },
		}),
		paths: "src/a.ts\0src/caller.ts\0",
	};
	const snapshot = GraphSnapshot.create(
		{
			tree: "a".repeat(40),
			version: "0.0.1",
			binary: "b".repeat(64),
			config: (await EnolaPolicy.load(repo, head)).hash,
		},
		{
			"facts.jsonl": artifacts["facts.jsonl"]!,
			"insights.json": artifacts["insights.json"]!,
			"receipt.json": artifacts["receipt.json"]!,
		},
	);
	const graphRead = vi.spyOn(GraphCache.prototype, "read").mockResolvedValue(cached ? snapshot : undefined);
	const graphStore = vi.spyOn(GraphCache.prototype, "store").mockResolvedValue(undefined);
	vi.spyOn(CoverageCache.prototype, "read").mockResolvedValue(undefined);
	vi.spyOn(CoverageCache.prototype, "store").mockResolvedValue("c".repeat(64));
	const shell = vi.spyOn(run, "shell").mockResolvedValue({ code: 0, output: "a".repeat(40) });
	const read = vi.spyOn(run, "readOutput").mockImplementation(async (path) => artifacts[path.split("/").at(-1)!]);
	const write = vi.spyOn(run.input.env, "writeFile").mockResolvedValue({ ok: true, value: undefined });
	const enola = await EnolaRun.open(run, repo, join(repo, "scratch"), tools);
	const files: ChangedFile[] = [
		{
			path: "src/a.ts",
			status: "modified",
			binary: false,
			hunks: [
				{ file: "src/a.ts", index: 0, oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, header: "", text: "" },
			],
		},
	];
	return { run, shell, read, write, artifacts, graphRead, graphStore, snapshot, enola, files };
}

it.each([
	["policy setup", "if [", "toolFailed", "policy setup exited"],
	["graph tree", "rev-parse", "worktreeFailed", "Could not resolve graph tree"],
	["generate", "--generate", "toolFailed", "Enola generate exited"],
	["baseline pin", "baseline pin", "toolFailed", "baseline pin exited"],
	["SARIF", "check --format", "toolFailed", "Enola check exited"],
	["base worktree", "worktree add", "worktreeFailed", "Enola base worktree failed"],
] as const)("fails closed when %s fails", async (_case, command, code, message) => {
	const f = await fixture(false);
	f.shell.mockImplementation(async (text) =>
		text.includes(command) ? { code: 2, output: "failure" } : { code: 0, output: "a".repeat(40) },
	);
	await expect(f.enola.check()).rejects.toMatchObject({ code, message: expect.stringContaining(message) });
});

it.each([
	["policy", "layer.yaml", "Could not copy Enola policy"],
	["config", "config.yaml", "Could not write Enola configuration"],
	["restore", "facts.jsonl", "Could not restore graph facts.jsonl"],
] as const)("fails closed on a %s write", async (_case, suffix, message) => {
	const f = await fixture();
	f.write.mockImplementation(async (path) =>
		path.endsWith(suffix)
			? { ok: false, error: Object.assign(new Error("denied"), { code: "permission_denied" as const }) }
			: { ok: true, value: undefined },
	);
	await expect(f.enola.check()).rejects.toMatchObject({
		code: "toolFailed",
		message: expect.stringContaining(message),
	});
});

it.each(["facts.jsonl", "insights.json", "receipt.json", "check.sarif"])("rejects missing %s", async (name) => {
	const f = await fixture(false);
	f.artifacts[name] = undefined;
	await expect(f.enola.check()).rejects.toMatchObject({
		code: "invalidOutput",
		message: expect.stringContaining(name === "check.sarif" ? "no SARIF" : `no ${name}`),
	});
});

it.each([
	["not JSON", "{", "not JSON"],
	[
		"format",
		JSON.stringify({ format_version: 2, snapshot_id: `sha256:${"a".repeat(64)}`, enola_version: "0.0.1" }),
		"unsupported",
	],
	["identity type", JSON.stringify({ format_version: 1, snapshot_id: 1, enola_version: "0.0.1" }), "unsupported"],
	[
		"identity format",
		JSON.stringify({ format_version: 1, snapshot_id: "bad", enola_version: "0.0.1" }),
		"unsupported",
	],
	[
		"version",
		JSON.stringify({ format_version: 1, snapshot_id: `sha256:${"a".repeat(64)}`, enola_version: "other" }),
		"unsupported",
	],
] as const)("rejects receipt %s", async (_case, receipt, message) => {
	const f = await fixture(false);
	f.artifacts["receipt.json"] = receipt;
	await expect(f.enola.check()).rejects.toMatchObject({
		code: "invalidOutput",
		message: expect.stringContaining(message),
	});
});

it("rejects invalid graph artifacts after receipt validation", async () => {
	const f = await fixture(false);
	f.artifacts["insights.json"] = "{";
	await expect(f.enola.check()).rejects.toMatchObject({
		code: "invalidOutput",
		message: "Enola graph artifacts are invalid",
	});
	expect(f.graphStore).not.toHaveBeenCalled();
});

it("copies present optional artifacts and attaches existing graph coverage", async () => {
	const f = await fixture(false);
	f.artifacts["snapshot.meta.json"] = "{}";
	const coverage = GraphCoverage.compute(
		"a".repeat(40),
		"0.0.1",
		{ format_version: 1, compiler: "fixture", files: [], symbols: [] },
		{ call: () => undefined, import: () => undefined },
	);
	vi.mocked(CoverageCache.prototype.read).mockResolvedValue(coverage);
	const result = await f.enola.check();
	if (result.status !== "ran") throw new Error("No check");
	expect(result.snapshots?.[0]?.coverage?.graph).toBe(coverage.id);
	expect(f.graphStore.mock.calls[0]?.[0].files()["snapshot.meta.json"]).toBe("{}");
});

it("rejects a short base hash before creating a worktree", async () => {
	const f = await fixture();
	Object.assign(f.run.input, { base: "short" });
	await expect(f.enola.check()).rejects.toMatchObject({
		code: "worktreeFailed",
		message: "Enola base must be a full commit hash",
	});
});

it("filters callers without locations and callers inside the diff", async () => {
	const f = await fixture();
	const data = await f.enola.callers(f.files, ["src/a.ts"]);
	expect(data.groups[0]?.callers).toEqual([{ name: "Caller", kind: "symbol", file: "src/caller.ts", line: 1 }]);
	expect(data.issues).toEqual([]);
	expect(data.paths).toEqual(["src/a.ts", "src/caller.ts"]);
});

it.each([1, 2])("queries every declaration sharing the changed range at line %i", async (start) => {
	const f = await fixture();
	f.artifacts["facts.jsonl"] = [
		{ id: "a", kind: "symbol", name: "src.a", file: "src/a.ts", line: 1 },
		{ id: "b", kind: "symbol", name: "src.b", file: "src/a.ts", line: 1 },
		{ id: "later", kind: "symbol", name: "src.later", file: "src/a.ts", line: 10 },
	]
		.map((fact) => JSON.stringify(fact))
		.join("\n");
	f.files[0] = { ...f.files[0]!, hunks: [{ ...f.files[0]!.hunks[0]!, newStart: start }] };
	f.shell.mockImplementation(async (command) => {
		for (const name of ["a", "b"])
			if (command.includes(`file:src/a.ts src.${name}'`))
				f.artifacts["impact.json"] = JSON.stringify({
					target: `src.${name}`,
					by_depth: { "1": [{ name: `src.calls${name}`, kind: "symbol", file: "src/caller.ts", line: 1 }] },
					edges: [],
					stats: { truncated: false },
				});
		return { code: 0, output: "a".repeat(40) };
	});
	const data = await f.enola.callers(f.files, ["src/a.ts"]);
	expect(data.groups.map((group) => ({ symbol: group.symbol, callers: group.callers }))).toEqual(
		["a", "b"].map((name) => ({
			symbol: `src.${name}`,
			callers: [{ name: `src.calls${name}`, kind: "symbol", file: "src/caller.ts", line: 1 }],
		})),
	);
	expect(data.issues).toEqual([]);
	expect(f.shell.mock.calls.filter(([command]) => command.includes("impact --json"))).toHaveLength(2);
});

it.each([
	[
		"different target",
		{ target: "Beta", by_depth: {}, edges: [], stats: { truncated: false } },
		"another full target",
	],
	["no report", undefined, "JSON"],
] as const)("omits caller groups for %s", async (_case, report, reason) => {
	const f = await fixture();
	f.artifacts["impact.json"] = report === undefined ? undefined : JSON.stringify(report);
	const data = await f.enola.callers(f.files, ["src/a.ts"]);
	expect(data.groups).toEqual([]);
	expect(data.issues[0]?.reason).toContain(reason);
});

it.each(["snapshot facts", "caller tree", "file listing"] as const)("rejects unavailable %s", async (failure) => {
	const f = await fixture();
	if (failure === "snapshot facts") f.artifacts["facts.jsonl"] = undefined;
	else {
		let trees = 0;
		f.shell.mockImplementation(async (command) => {
			if (failure === "caller tree" && command.includes("rev-parse") && ++trees === 2)
				return { code: 1, output: "failure" };
			if (failure === "file listing" && command.includes("ls-tree")) return { code: 1, output: "failure" };
			return { code: 0, output: "a".repeat(40) };
		});
	}
	await expect(f.enola.callers(f.files, ["src/a.ts"])).rejects.toMatchObject({
		message: expect.stringContaining(
			failure === "snapshot facts"
				? "has no facts"
				: failure === "caller tree"
					? "caller graph tree"
					: "caller graph files",
		),
	});
});

it("records ambiguity before querying duplicate symbol names", async () => {
	const f = await fixture();
	f.artifacts["facts.jsonl"] +=
		`\n${JSON.stringify({ id: "duplicate", kind: "symbol", name: "Alpha", file: "src/b.ts", line: 1 })}`;
	const data = await f.enola.callers(f.files, ["src/a.ts"]);
	expect(data.groups).toEqual([]);
	expect(data.issues[0]?.reason).toContain("ambiguous");
	expect(f.shell.mock.calls.some(([command]) => command.includes("impact --json"))).toBe(false);
});

it("ignores non-symbol facts and declarations outside the changed range", async () => {
	const f = await fixture();
	f.artifacts["facts.jsonl"] +=
		"\n" +
		[
			{ id: "file", kind: "file_ref", name: "Alpha", file: "src/a.ts" },
			{ id: "later", kind: "symbol", name: "Later", file: "src/a.ts", line: 10 },
		]
			.map((fact) => JSON.stringify(fact))
			.join("\n");
	const data = await f.enola.callers(f.files, ["src/a.ts"]);
	expect(data.groups.map((group) => group.symbol)).toEqual(["Alpha"]);
	expect(data.issues).toEqual([]);
});

it("stops querying when the caller time budget ends", async () => {
	const f = await fixture(true, 0);
	const data = await f.enola.callers(f.files, ["src/a.ts"]);
	expect(data.groups).toEqual([]);
	expect(data.issues[0]?.reason).toContain("time budget ended");
	expect(f.shell.mock.calls.some(([command]) => command.includes("impact --json"))).toBe(false);
});

it("caps changed-symbol queries at 128 and records the omitted count", async () => {
	const f = await fixture();
	f.artifacts["facts.jsonl"] = Array.from({ length: 129 }, (_, i) =>
		JSON.stringify({ id: `a${i}`, kind: "symbol", name: `Alpha${i}`, file: "src/a.ts", line: i + 1 }),
	).join("\n");
	f.files[0] = { ...f.files[0]!, hunks: [{ ...f.files[0]!.hunks[0]!, newLines: 129 }] };
	f.shell.mockImplementation(async (command) => {
		const target = /file:src\/a.ts (Alpha\d+)/.exec(command)?.[1];
		if (target)
			f.artifacts["impact.json"] = JSON.stringify({ target, by_depth: {}, edges: [], stats: { truncated: false } });
		return { code: 0, output: "a".repeat(40) };
	});
	const data = await f.enola.callers(f.files, ["src/a.ts"]);
	expect(data.groups).toHaveLength(128);
	expect(data.issues).toEqual([]);
	expect(data.notes).toEqual(["1 changed symbols omitted at the caller-query limit of 128."]);
	expect(f.shell.mock.calls.filter(([command]) => command.includes("impact --json"))).toHaveLength(128);
});

it("uses head as the baseline when no base is supplied", async () => {
	const f = await fixture();
	const run = new Run({ ...f.run.input, base: undefined }, context);
	vi.spyOn(run, "shell").mockImplementation((command, timeout) => f.run.shell(command, timeout));
	vi.spyOn(run, "readOutput").mockImplementation((path) => f.run.readOutput(path));
	const enola = await EnolaRun.open(run, repo, join(repo, "scratch"), f.run.input.tools!);
	const result = await enola.check();
	if (result.status !== "ran") throw new Error("No check");
	expect(result.snapshots?.map((snapshot) => snapshot.commit)).toEqual([f.run.input.commit, f.run.input.commit]);
	expect(f.shell.mock.calls.find(([command]) => command.includes("worktree add"))?.[0]).toContain(f.run.input.commit);
});

it("queries a deletion's remaining declaration and bounds symbols by the next declaration", async () => {
	const f = await fixture();
	f.artifacts["facts.jsonl"] = [
		{ id: "early", kind: "symbol", name: "Early", file: "src/a.ts", line: 1 },
		{ id: "alpha", kind: "symbol", name: "Alpha", file: "src/a.ts", line: 10 },
		{ id: "later", kind: "symbol", name: "Later", file: "src/a.ts", line: 11 },
	]
		.map((fact) => JSON.stringify(fact))
		.join("\n");
	f.files[0] = { ...f.files[0]!, hunks: [{ ...f.files[0]!.hunks[0]!, newStart: 10, newLines: 0 }] };
	const data = await f.enola.callers(f.files, ["src/a.ts"]);
	expect(data.groups.map((group) => group.symbol)).toEqual(["Alpha"]);
	expect(data.issues).toEqual([]);
});

it("passes the constraint fail-on flag when the base supplies constraints", async () => {
	const f = await fixture();
	await f.enola.check();
	expect(
		f.shell.mock.calls.filter(([command]) => command.includes("check --format")).map(([command]) => command),
	).toEqual([expect.stringContaining("--fail-on='constraints'"), expect.stringContaining("--fail-on='constraints'")]);
});

it.each([
	[29_999, 30_000, 1],
	[28_800, 28_800, 2],
])(
	"bounds a query with guard time %s and invocation time %s to %s seconds",
	async (guardTime, invocationTime, timeout) => {
		const f = await fixture();
		const now = vi.spyOn(Date, "now").mockReturnValue(0);
		f.read.mockImplementation(async (path) => {
			if (path.endsWith("facts.jsonl"))
				now.mockReset().mockReturnValueOnce(0).mockReturnValueOnce(guardTime).mockReturnValue(invocationTime);
			return f.artifacts[path.split("/").at(-1)!];
		});
		try {
			const data = await f.enola.callers(f.files, ["src/a.ts"]);
			expect(data.issues).toEqual([]);
			const query = f.shell.mock.calls.find(([command]) => command.includes("impact --json"));
			expect(query?.[1]).toBe(timeout);
			expect(query?.[0]).toContain("--max-depth 1 --max-nodes 50");
			expect(query?.[0]).toContain("ulimit -f 16384");
		} finally {
			now.mockRestore();
		}
	},
);

it.each([
	["generate", "--generate", "generate.log", "Enola generate exited 2: "],
	["check", "check --format", "check.err", "Enola check exited 2: "],
])("caps %s diagnostics at 4096 characters", async (_phase, command, output, prefix) => {
	const f = await fixture(false);
	f.artifacts[output] = "x".repeat(5000);
	f.shell.mockImplementation(async (text) => ({ code: text.includes(command) ? 2 : 0, output: "a".repeat(40) }));
	await expect(f.enola.check()).rejects.toMatchObject({ code: "toolFailed", message: `${prefix}${"x".repeat(4096)}` });
});
