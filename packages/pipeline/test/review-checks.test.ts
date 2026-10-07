import { spawn } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
	Changeset,
	CheckError,
	defaultConfig,
	Lens,
	loadConfig,
	type MelianConfig,
	ReviewPlan,
} from "@melian-agent/core";
import {
	type Context,
	backgroundContext as context,
	createMemoryStorage,
	createNodeExecutionEnv,
	createReviewRegistry,
	openHarness,
	openReviewHarness,
	openSqliteStorage,
	type ReviewHarness,
	type ReviewOptions,
	readVerdict,
	reviewChangeset,
	revisionKey,
} from "@melian-agent/pipeline";
import { createFakeModels, fauxAssistantMessage, scriptConversations } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as checks from "../src/checks.ts";
import { ChecksDocument } from "../src/checks.ts";
import { commit, createRepository, fakeTool, lines } from "./fixtures/repo.ts";

let repo: string;
let opened: ReviewHarness[];
beforeEach(() => {
	repo = createRepository();
	opened = [];
});
afterEach(async () => {
	await Promise.all(opened.map((review) => review.close()));
	vi.restoreAllMocks();
	rmSync(repo, { recursive: true, force: true });
});

async function setup(checkout = true) {
	const base = commit(repo, {
		".gitignore": "node_modules\n",
		"melian.yaml": lines("tiers:", "  full: [guardrails, static.biome, static.tsc]"),
		"tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, noEmit: true } }),
		"src/a.ts": "export const a = 1;\n",
	});
	const head = commit(repo, { "src/a.ts": "export const a = 2;\n" });
	const changeset = await Changeset.resolve(repo, `${base}..${head}`);
	const policy = { kind: "revision", commit: base } as const;
	const { config } = await loadConfig(repo, policy, ".");
	const fake = createFakeModels();
	const harness = await openReviewHarness(createMemoryStorage(), fake.review, {
		retry: false,
		...(checkout ? { checkout: repo } : {}),
	});
	opened.push(harness);
	return { harness, changeset, policy, config, lenses: [], standards: [], models: fake.review };
}

describe("review drives checks", { timeout: 60_000 }, () => {
	it("runs a clean change and attaches to the same check task after a model override", async () => {
		const options = await setup();
		const automatic = vi.spyOn(checks, "runChecks");
		const first = await reviewChangeset(options);
		expect(first.verdict.status).toBe("passed");
		expect(first.verdict.ran!.map(({ name, status }) => [name, status])).toEqual([
			["guardrails", "ran"],
			["static.biome", "ran"],
			["static.tsc", "ran"],
		]);
		const plan = ReviewPlan.resolve({
			config: defaultConfig,
			routes: (await loadConfig(repo, options.policy, ".")).routes,
			model: "test/changed",
			checks: [],
			lenses: [],
			catalog: [],
			credentials: {},
		});
		await reviewChangeset({ ...options, plan });
		expect(automatic.mock.calls.map(([, request]) => request.config)).toEqual([options.config, options.config]);
		expect(
			Object.keys(
				(await options.harness.harness.snapshot(
					ChecksDocument,
					(
						await options.harness.harness.root(context)
					).id,
					context,
				))!.tasks,
			),
		).toHaveLength(1);
	});

	it("reruns a cached failed compiler through the automatic path", async () => {
		const options = await setup();
		const log = join(repo, "compiler.log");
		fakeTool(
			repo,
			"tsc",
			`if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\necho ran >> '${log}'\nexit 139`,
		);
		const first = await reviewChangeset(options);
		expect(first.verdict.notRun.find(({ name }) => name === "static.tsc")!.status).toBe("failed");
		const before = readFileSync(log, "utf8");
		fakeTool(repo, "tsc", `if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\necho ran >> '${log}'`);
		expect((await reviewChangeset(options)).verdict.status).toBe("not-reviewed");
		expect(readFileSync(log, "utf8")).toBe(before);
		const rerun = await reviewChangeset({ ...options, rerun: true });
		expect(rerun.verdict.status).toBe("passed");
		expect(rerun.verdict.ran!.find(({ name }) => name === "static.tsc")!.status).toBe("ran");
		expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(before.trim().split("\n").length + 2);
	});

	it("supplied records bypass checks even without policy", async () => {
		const { policy: _, ...options } = await setup();
		const result = await reviewChangeset({ ...options, checks: [{ name: "guardrails", status: "ran" }] });
		expect(result.verdict.status).toBe("not-reviewed");
		expect(result.verdict.ran).toEqual([{ name: "guardrails", status: "ran" }]);
		expect(
			(
				await options.harness.harness.snapshot(
					ChecksDocument,
					(
						await options.harness.harness.root(context)
					).id,
					context,
				)
			)?.tasks ?? {},
		).toEqual({});
	});

	it("an empty supplied list opts out of checks on a capable wrapper", async () => {
		const { policy: _, ...options } = await setup();
		const result = await reviewChangeset({ ...options, checks: [] });
		expect(result.verdict.status).toBe("not-reviewed");
		expect(result.verdict.notRun.every((check) => check.status === "skipped" && check.reason === "no record")).toBe(
			true,
		);
		const root = await options.harness.harness.root(context);
		expect((await options.harness.harness.snapshot(ChecksDocument, root.id, context))?.tasks ?? {}).toEqual({});
	});

	it("an environment-less harness leaves missing records not reviewed", async () => {
		const options = await setup(false);
		const automatic = vi.spyOn(checks, "runChecks").mockRejectedValue(new Error("unexpected automatic checks"));
		const result = await reviewChangeset(options);
		expect(automatic).not.toHaveBeenCalled();
		expect(result.verdict.status).toBe("not-reviewed");
		expect(result.verdict.notRun.every((check) => check.status === "skipped" && check.reason === "no record")).toBe(
			true,
		);
	});

	it.each(["explicit", "stage", "default"] as const)(
		"uses the %s tier and the host's invocation for automatic checks",
		async (choice) => {
			const options = await setup();
			const config: MelianConfig = {
				...options.config,
				stages: choice === "default" ? {} : { "pull-request": "standard" },
				tiers: { full: ["guardrails"], standard: ["guardrails"], fast: [] },
			};
			const invocation: Context = {
				abortSignal: new AbortController().signal,
				value: (key) => context.value(key),
				toString: () => "automatic-checks-test",
			};
			const automatic = vi.spyOn(checks, "runChecks");
			const result = await reviewChangeset({
				...options,
				config,
				context: invocation,
				...(choice === "explicit" ? { tier: "fast" } : {}),
			});
			expect(result.verdict.status).toBe("passed");
			expect(result.verdict.ran!.map(({ name }) => name)).toEqual(choice === "explicit" ? [] : ["guardrails"]);
			expect(automatic).toHaveBeenCalledTimes(1);
			const [calledHarness, request, calledContext] = automatic.mock.calls[0]!;
			expect(calledHarness).toBe(options.harness.harness);
			expect(calledContext).toBe(invocation);
			expect(request).toMatchObject({
				rootConversationId: (await options.harness.harness.root(invocation)).id,
				tier: choice === "explicit" ? "fast" : choice === "stage" ? "standard" : "full",
			});
			expect(request.changeset).toBe(options.changeset);
			expect(request.config).toBe(config);
			expect(request.source).toBe(options.policy);
		},
	);

	it("refuses a raw harness without records even when it has an environment", async () => {
		const options = await setup(false);
		const fake = createFakeModels();
		const raw = await openHarness(createMemoryStorage(), {
			models: fake.models,
			registry: createReviewRegistry(),
			env: () => createNodeExecutionEnv(repo),
			settings: { retry: { enabled: false } },
		});
		try {
			await expect(
				reviewChangeset({ ...options, harness: raw, models: fake.review } as unknown as ReviewOptions),
			).rejects.toMatchObject({
				code: "notInstalled",
				message:
					"automatic checks require ReviewHarness; raw harness callers must supply checks, including an empty array",
				lenses: [],
			});
			expect((await raw.inspect(context)).tasks).toEqual([]);
			const result = await reviewChangeset({ ...options, harness: raw, models: fake.review, checks: [] });
			expect(result.verdict.status).toBe("not-reviewed");
			expect(
				result.verdict.notRun.every((check) => check.status === "skipped" && check.reason === "no record"),
			).toBe(true);
		} finally {
			await raw.close(context);
		}
	});

	it("refuses the capable wrapper's raw harness instead of silently skipping checks", async () => {
		const options = await setup();
		await expect(
			reviewChangeset({ ...options, harness: options.harness.harness } as unknown as ReviewOptions),
		).rejects.toMatchObject({ code: "notInstalled" });
		expect((await options.harness.harness.inspect(context)).tasks).toEqual([]);
		expect((await reviewChangeset(options)).verdict.status).toBe("passed");
	});

	it("refuses missing policy before starting any task", async () => {
		const { policy: _, ...options } = await setup();
		await expect(reviewChangeset(options)).rejects.toMatchObject({
			code: "missingPolicy",
			message: "automatic checks require the policy source the host chose",
			lenses: [],
		});
		expect((await options.harness.harness.inspect(context)).tasks).toEqual([]);
	});
	it("propagates an unfinished automatic check without recording a verdict", async () => {
		const options = await setup();
		const error = new CheckError("notCompleted", "full", "checks were interrupted");
		vi.spyOn(checks, "runChecks").mockRejectedValue(error);

		await expect(reviewChangeset(options)).rejects.toBe(error);

		const raw = options.harness.harness;
		expect((await raw.inspect(context)).tasks).toEqual([]);
		expect(
			await readVerdict(raw, (await raw.root(context)).id, revisionKey(options.changeset.revision), context),
		).toBeUndefined();
	});
	it("resumes after checks committed without running a tool twice", async () => {
		const options = await setup();
		await options.harness.close();
		const database = join(repo, "review.sqlite");
		const log = join(repo, "tools.log");
		fakeTool(
			repo,
			"tsc",
			`if [ "$1" = "--version" ]; then echo "Version 0.0.1"; exit 0; fi\necho ran >> '${log.replaceAll("'", "'\\''")}'`,
		);
		const ready = join(repo, "ready");
		const child = spawn(
			process.execPath,
			[
				"--conditions=@melian-agent/source",
				fileURLToPath(new URL("./fixtures/review-checks-crash.ts", import.meta.url)),
				repo,
				options.changeset.revision.base,
				options.changeset.revision.head,
				database,
				ready,
			],
			{ stdio: ["ignore", "ignore", "pipe"] },
		);
		let stderr = "";
		child.stderr.on("data", (chunk) => {
			stderr += chunk;
		});
		const exited = new Promise((resolve) => child.on("exit", (code, signal) => resolve(signal ?? code)));
		const deadline = Date.now() + 20_000;
		try {
			while (true) {
				try {
					if (readFileSync(ready, "utf8") === "ready") break;
				} catch {}
				if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
					throw new Error(stderr || "crash fixture did not reach its lens");
				await sleep(20);
			}
		} finally {
			child.kill("SIGKILL");
		}
		expect(await exited).toBe("SIGKILL");
		expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
		const fake = createFakeModels();
		scriptConversations(fake, [
			{ match: "You are the correctness reviewer", replies: [fauxAssistantMessage("Done.")] },
		]);
		const harness = await openReviewHarness(await openSqliteStorage(database), fake.review, {
			checkout: repo,
			retry: false,
		});
		opened.push(harness);
		const ref = fake.ref();
		const result = await reviewChangeset({
			...options,
			harness,
			models: fake.review,
			config: {
				...options.config,
				tiers: { full: ["guardrails", "static.tsc", "lens.correctness"] },
				models: { heavy: { model: `${ref.provider}/${ref.modelId}` } },
			},
			lenses: await Lens.load(repo, options.policy, options.changeset.revision.paths()),
		});
		expect(result.verdict.status).toBe("passed");
		expect(readFileSync(log, "utf8").trim().split("\n")).toHaveLength(2);
		expect(
			Object.keys(
				(await harness.harness.snapshot(ChecksDocument, (await harness.harness.root(context)).id, context))!.tasks,
			),
		).toHaveLength(1);
	});
});
