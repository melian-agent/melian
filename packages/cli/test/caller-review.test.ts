import { join } from "node:path";
import { ReviewPlan } from "@melian-agent/core";
import { CallerContext, planInputs } from "@melian-agent/pipeline";
import {
	createFakeModels,
	fauxAssistantMessage,
	scriptConversations,
	systemPromptOf,
} from "@melian-agent/pipeline/testing";
import { afterEach, expect, it, vi } from "vitest";
import { commit, createRepository, gitIn, removeRepository } from "../../pipeline/test/fixtures/repo.ts";
import type { Io } from "../src/commands.ts";
import { main } from "../src/main.ts";
import * as modelSetup from "../src/models.ts";

let repo: string;
afterEach(() => {
	vi.restoreAllMocks();
	if (repo) removeRepository(repo);
});

it.each([true, false])(
	"supplies CLI caller context and coverage with head checked out: %s",
	async (checkedOut) => {
		repo = createRepository();
		const base = commit(repo, {
			"src/a.ts": "export const a = 1;\n",
			"melian.yaml":
				"tiers:\n  fast: [lens.correctness]\n  full: [fast]\nstatic:\n  enola: {enabled: true}\n" +
				"lenses:\n" +
				["contracts", "trust-boundary", "removed-behaviour", "tests", "conventions"]
					.map((name) => `  ${name}: {enabled: false}\n`)
					.join(""),
		});
		gitIn(repo, "checkout", "-b", "feature");
		const head = commit(repo, { "src/a.ts": "export const a = 2;\n" });
		if (!checkedOut) gitIn(repo, "checkout", "--quiet", "main");
		const fake = createFakeModels();
		const ref = fake.ref();
		const requests = scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		vi.spyOn(modelSetup, "reviewModels").mockImplementation(async (_env, loaded, lenses, options) => ({
			models: fake.review,
			plan: ReviewPlan.resolve({
				config: loaded.config,
				routes: loaded.routes,
				model: `${ref.provider}/${ref.modelId}`,
				...(await planInputs(fake.review)),
				lenses,
				checks: options.checks,
			}),
			retry: false,
		}));
		const callers = CallerContext.from({
			groups: [
				{
					file: "src/a.ts",
					symbol: "a",
					callers: [{ name: "OutsideCaller", kind: "symbol", file: "src/caller.ts", line: 2 }],
					truncated: false,
				},
			],
			issues: [],
			notes: [],
			paths: [],
		});
		vi.spyOn(CallerContext, "open").mockResolvedValue(callers);
		vi.spyOn(CallerContext.prototype, "recordCoverage").mockResolvedValue({ review: "a".repeat(64) });
		const lines: string[] = [],
			errors: string[] = [];
		const io: Io = {
			cwd: repo,
			env: {
				MELIAN_TEST_SCRIPT: "injected",
				MELIAN_STATE_DIR: join(repo, "state"),
				XDG_CONFIG_HOME: join(repo, "config"),
				PI_CODING_AGENT_DIR: join(repo, "pi"),
			},
			stdout: (text) => lines.push(text),
			stderr: (text) => errors.push(text),
			color: false,
		};
		expect(await main(["review", "main...feature"], io), errors.join("")).toBe(0);
		expect(CallerContext.open).toHaveBeenCalledWith(
			expect.objectContaining({ commit: head }),
			[expect.objectContaining({ path: "src/a.ts" })],
			expect.anything(),
			["src/a.ts"],
		);
		expect(vi.mocked(CallerContext.open).mock.calls[0]?.[0].policyCommit).toBe(checkedOut ? undefined : base);
		expect(systemPromptOf(requests["You are the correctness reviewer"]![0]!)).toContain("OutsideCaller");
		lines.length = 0;
		expect(await main(["findings", "main...feature", "--json"], io)).toBe(0);
		expect(JSON.parse(lines.join("")).ran).toContainEqual(
			expect.objectContaining({ name: "lens.correctness", coverage: { review: "a".repeat(64) } }),
		);
	},
	60_000,
);

it("queries callers for lens-selected files and drops callers in every changed file", async () => {
	repo = createRepository();
	const body = "export const moved = 1;\nexport const kept = 2;\nexport const more = 3;\nexport const rest = 4;\n";
	commit(repo, {
		"src/a.ts": "export const a = 1;\n",
		"docs/b.md": "one\n",
		"src/old.ts": body,
		"melian.yaml":
			"tiers:\n  fast: [lens.correctness]\n  full: [fast]\nstatic:\n  enola: {enabled: true}\n" +
			"lenses:\n  correctness: {paths: [src/a.ts, src/old.ts]}\n" +
			["contracts", "trust-boundary", "removed-behaviour", "tests", "conventions"]
				.map((name) => `  ${name}: {enabled: false}\n`)
				.join(""),
	});
	gitIn(repo, "checkout", "-b", "feature");
	gitIn(repo, "mv", "src/old.ts", "src/new.ts");
	commit(repo, { "src/a.ts": "export const a = 2;\n", "docs/b.md": "two\n" });
	const fake = createFakeModels();
	const ref = fake.ref();
	scriptConversations(fake, [{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] }]);
	vi.spyOn(modelSetup, "reviewModels").mockImplementation(async (_env, loaded, lenses, options) => ({
		models: fake.review,
		plan: ReviewPlan.resolve({
			config: loaded.config,
			routes: loaded.routes,
			model: `${ref.provider}/${ref.modelId}`,
			...(await planInputs(fake.review)),
			lenses,
			checks: options.checks,
		}),
		retry: false,
	}));
	vi.spyOn(CallerContext, "open").mockResolvedValue(
		CallerContext.from({ groups: [], issues: [], notes: [], paths: [] }),
	);
	const errors: string[] = [];
	const io: Io = {
		cwd: repo,
		env: {
			MELIAN_TEST_SCRIPT: "injected",
			MELIAN_STATE_DIR: join(repo, "state"),
			XDG_CONFIG_HOME: join(repo, "config"),
			PI_CODING_AGENT_DIR: join(repo, "pi"),
		},
		stdout: () => {},
		stderr: (text) => errors.push(text),
		color: false,
	};
	expect(await main(["review", "main...feature"], io), errors.join("")).toBe(0);
	const call = vi.mocked(CallerContext.open).mock.calls[0]!;
	expect(call[1].map((file) => [file.path, file.oldPath]).sort()).toEqual([
		["src/a.ts", undefined],
		["src/new.ts", "src/old.ts"],
	]);
	expect([...call[3]!].sort()).toEqual(["docs/b.md", "src/a.ts", "src/new.ts"]);
}, 60_000);

it("skips caller context when the Enola check is disabled", async () => {
	repo = createRepository();
	commit(repo, {
		"src/a.ts": "export const a = 1;\n",
		"melian.yaml":
			"tiers:\n  fast: [lens.correctness]\n  full: [fast]\nstatic:\n  enola: {enabled: false}\n" +
			"lenses:\n" +
			["contracts", "trust-boundary", "removed-behaviour", "tests", "conventions"]
				.map((name) => `  ${name}: {enabled: false}\n`)
				.join(""),
	});
	gitIn(repo, "checkout", "-b", "feature");
	commit(repo, { "src/a.ts": "export const a = 2;\n" });
	const fake = createFakeModels();
	const ref = fake.ref();
	const requests = scriptConversations(fake, [
		{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
	]);
	vi.spyOn(modelSetup, "reviewModels").mockImplementation(async (_env, loaded, lenses, options) => ({
		models: fake.review,
		plan: ReviewPlan.resolve({
			config: loaded.config,
			routes: loaded.routes,
			model: `${ref.provider}/${ref.modelId}`,
			...(await planInputs(fake.review)),
			lenses,
			checks: options.checks,
		}),
		retry: false,
	}));
	const callers = CallerContext.from({
		groups: [
			{
				file: "src/a.ts",
				symbol: "a",
				callers: [{ name: "OutsideCaller", kind: "symbol", file: "src/caller.ts", line: 2 }],
				truncated: false,
			},
		],
		issues: [],
		notes: [],
		paths: [],
	});
	vi.spyOn(CallerContext, "open").mockResolvedValue(callers);
	const errors: string[] = [];
	const io: Io = {
		cwd: repo,
		env: {
			MELIAN_TEST_SCRIPT: "injected",
			MELIAN_STATE_DIR: join(repo, "state"),
			XDG_CONFIG_HOME: join(repo, "config"),
			PI_CODING_AGENT_DIR: join(repo, "pi"),
		},
		stdout: () => {},
		stderr: (text) => errors.push(text),
		color: false,
	};
	expect(await main(["review", "main...feature"], io), errors.join("")).toBe(0);
	expect(CallerContext.open).not.toHaveBeenCalled();
	const prompt = systemPromptOf(requests["You are the correctness reviewer"]![0]!);
	expect(prompt).not.toContain("Candidate callers");
	expect(prompt).not.toContain("OutsideCaller");
}, 60_000);

async function openedFor(tiers: string, lenses: string): Promise<readonly string[] | undefined> {
	repo = createRepository();
	commit(repo, {
		"src/a.ts": "export const a = 1;\n",
		"docs/b.md": "one\n",
		"melian.yaml": `tiers:\n${tiers}\nstatic:\n  enola: {enabled: true}\nlenses:\n${lenses}`,
	});
	gitIn(repo, "checkout", "-b", "feature");
	commit(repo, { "src/a.ts": "export const a = 2;\n", "docs/b.md": "two\n" });
	const fake = createFakeModels();
	const ref = fake.ref();
	scriptConversations(fake, [{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] }]);
	vi.spyOn(modelSetup, "reviewModels").mockImplementation(async (_env, loaded, lenses, options) => ({
		models: fake.review,
		plan: ReviewPlan.resolve({
			config: loaded.config,
			routes: loaded.routes,
			model: `${ref.provider}/${ref.modelId}`,
			...(await planInputs(fake.review)),
			lenses,
			checks: options.checks,
		}),
		retry: false,
	}));
	vi.spyOn(CallerContext, "open").mockResolvedValue(
		CallerContext.from({ groups: [], issues: [], notes: [], paths: [] }),
	);
	const errors: string[] = [];
	const io: Io = {
		cwd: repo,
		env: {
			MELIAN_TEST_SCRIPT: "injected",
			MELIAN_STATE_DIR: join(repo, "state"),
			XDG_CONFIG_HOME: join(repo, "config"),
			PI_CODING_AGENT_DIR: join(repo, "pi"),
		},
		stdout: () => {},
		stderr: (text) => errors.push(text),
		color: false,
	};
	await main(["review", "main...feature"], io);
	return vi.mocked(CallerContext.open).mock.calls[0]?.[1].map((file) => file.path);
}

const others = ["trust-boundary", "removed-behaviour", "tests", "conventions"]
	.map((name) => `  ${name}: {enabled: false}\n`)
	.join("");

it("queries callers only for files the tier's lenses select, not an enabled lens outside the tier", async () => {
	const files = await openedFor(
		"  fast: [lens.correctness]\n  full: [fast]",
		`  correctness: {paths: [src/a.ts]}\n  contracts: {paths: [docs/b.md]}\n${others}`,
	);
	expect(files).toEqual(["src/a.ts"]);
}, 60_000);

it("queries callers for no file when the tier names no lens", async () => {
	const files = await openedFor(
		"  fast: [static.enola]\n  full: [fast]",
		`  correctness: {paths: [src/a.ts]}\n  contracts: {paths: [docs/b.md]}\n${others}`,
	);
	expect(files).toEqual([]);
}, 60_000);
