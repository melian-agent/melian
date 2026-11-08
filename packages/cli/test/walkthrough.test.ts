import { copyFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Changeset, Revision } from "@melian-agent/core";
import { createGitHubProvider } from "@melian-agent/github";
import * as pipeline from "@melian-agent/pipeline";
import { backgroundContext as context, createRegistry, openHarness, openSqliteStorage } from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type FakeState, fakeGitHub } from "../../github/test/fixtures/fake-github.ts";
import { moveTo, pullRequestState } from "../../github/test/fixtures/scenario.ts";
import { VerdictDocument } from "../../pipeline/src/adjudication.ts";
import { baseAndHead, isolatedGitEnv } from "../../pipeline/test/fixtures/repo.ts";
import { publish, review } from "../src/commands.ts";
import { main } from "../src/main.ts";
import { storagePath } from "../src/repository.ts";
import * as targets from "../src/target.ts";

let repo: string;
let changeset: Changeset;
let env: NodeJS.ProcessEnv;
beforeEach(async () => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = baseAndHead(
		{ "src/a.ts": "export const a = 1;\n", "melian.yaml": "tiers:\n  full: [guardrails]\n" },
		{ "src/a.ts": "export const a = 2;\n" },
	);
	changeset = await Changeset.resolve(repo, "main...feature");
	const state = pullRequestState();
	moveTo(state, changeset);
	const provider = createGitHubProvider({
		owner: state.owner,
		repo: state.repo,
		token: "test-token",
		fetch: fakeGitHub(state),
	});
	vi.spyOn(targets, "gitHubFor").mockResolvedValue(provider);
	vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({ pullRequest: await provider.pullRequest(7), changeset });
	const script = join(repo, "script.json");
	writeFileSync(script, "{}");
	env = { ...process.env, MELIAN_TEST_SCRIPT: script };
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});
async function recorded() {
	const fake = createFakeModels();
	const path = await storagePath(repo, changeset.id, env, true);
	const harness = await openHarness(await openSqliteStorage(path), {
		models: fake.models,
		registry: createRegistry(),
	});
	try {
		return await harness.snapshot(VerdictDocument, (await harness.root(context)).id, context);
	} finally {
		await harness.close(context);
	}
}
describe("CLI walkthrough switch", { timeout: 60_000 }, () => {
	it("skips the summariser with --no-walkthrough and keeps a summary failure out of the review exit code", async () => {
		const output: string[] = [];
		const io = {
			cwd: repo,
			env,
			stdout: (text: string) => output.push(text),
			stderr: (text: string) => output.push(text),
			color: false,
		};
		expect(await review(io, "#7", { rerun: false, walkthrough: false })).toBe(0);
		expect((await recorded())?.walkthroughs).toBeUndefined();
		expect((await recorded())?.walkthroughNotes).toBeUndefined();
		expect(await review(io, "#7", { rerun: false })).toBe(0);
		expect((await recorded())?.walkthroughNotes?.[Revision.key(changeset.revision)]).toBeDefined();
		expect(output.every((text) => !text.includes("summariser"))).toBe(true);
	});
});

describe("CLI walkthrough beside the review", { timeout: 60_000 }, () => {
	function gate() {
		let open = () => {};
		const opened = new Promise<void>((resolve) => {
			open = resolve;
		});
		return { opened, open };
	}

	it("starts the walkthrough inside the review, from its origin and plan, and prints only once it ends", async () => {
		const order: string[] = [];
		const released = gate();
		const summarize = vi.spyOn(pipeline, "summarizeReview").mockImplementation(async () => {
			order.push("walkthrough started");
			await released.opened;
			order.push("walkthrough ended");
		});
		const actual = pipeline.reviewChangeset;
		vi.spyOn(pipeline, "reviewChangeset").mockImplementation(async (request) => {
			// This repository runs no lens, so the wrapper calls the hook as reviewChangeset does once its lenses start.
			request.lensesStarted?.();
			const reviewed = await actual(request);
			order.push("review ended");
			// Released well after the review returns, so output printed without waiting for it would come first.
			setTimeout(released.open, 200);
			return reviewed;
		});
		const io = {
			cwd: repo,
			env,
			stdout: () => {
				order.push("output");
			},
			stderr: () => {},
			color: false,
		};

		expect(await review(io, "#7", { rerun: false })).toBe(0);

		expect(order).toEqual(["walkthrough started", "review ended", "walkthrough ended", "output"]);
		expect(summarize).toHaveBeenCalledOnce();
		const { origin, plan } = summarize.mock.calls[0]![0];
		expect(origin).toMatchObject({ kind: "pull-request", pullRequest: 7, head: changeset.revision.head });
		expect(plan).toBeDefined();
	});

	it("times the wait for the walkthrough in no preparation step", async () => {
		const reviewed = gate();
		vi.spyOn(pipeline, "summarizeReview").mockImplementation(async () => {
			await reviewed.opened;
			await new Promise((resolve) => setTimeout(resolve, 1000));
		});
		const actual = pipeline.reviewChangeset;
		vi.spyOn(pipeline, "reviewChangeset").mockImplementation(async (request) => {
			const result = await actual(request);
			reviewed.open();
			return result;
		});
		let output = "";
		const io = {
			cwd: repo,
			env,
			stdout: (text: string) => {
				output += text;
			},
			stderr: () => {},
			color: false,
		};

		expect(await review(io, "#7", { rerun: false, json: true })).toBe(0);

		const { telemetry } = JSON.parse(output) as {
			telemetry: { prepare: { spans: { name: string; durationMs: number }[] } };
		};
		const read = telemetry.prepare.spans.find((span) => span.name === "verdict.read");
		expect(read).toBeDefined();
		expect(read!.durationMs).toBeLessThan(1000);
	});

	it("times the walkthrough's credential unlock in no preparation step", async () => {
		vi.spyOn(pipeline, "summarizeReview").mockImplementation(async ({ unlockModels }) => {
			await unlockModels!(["light-provider"]);
		});
		vi.spyOn(pipeline, "unlockCredentials").mockImplementation(async (_models, providers) => {
			if (providers.includes("light-provider")) await new Promise((resolve) => setTimeout(resolve, 300));
		});
		let output = "";
		const io = {
			cwd: repo,
			env,
			stdout: (text: string) => {
				output += text;
			},
			stderr: () => {},
			color: false,
		};

		expect(await review(io, "#7", { rerun: false, json: true })).toBe(0);

		const { telemetry } = JSON.parse(output) as {
			telemetry: { prepare: { spans: { name: string; durationMs: number }[] } };
		};
		expect(telemetry.prepare.spans.filter((span) => span.durationMs >= 300)).toEqual([]);
	});

	it("times the wait for a failed review's walkthrough in no preparation step", async () => {
		vi.spyOn(pipeline, "summarizeReview").mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 500));
		});
		vi.spyOn(pipeline, "reviewChangeset").mockImplementation(async (request) => {
			request.lensesStarted?.();
			throw new Error("lenses broke");
		});
		let output = "";
		const io = {
			cwd: repo,
			env,
			stdout: (text: string) => {
				output += text;
			},
			stderr: () => {},
			color: false,
		};

		await expect(review(io, "#7", { rerun: false, json: true })).rejects.toThrow("lenses broke");

		const { telemetry } = JSON.parse(output) as {
			telemetry: { prepare: { spans: { name: string; durationMs: number }[] } };
		};
		expect(telemetry.prepare.spans.length).toBeGreaterThan(0);
		expect(telemetry.prepare.spans.filter((span) => span.durationMs >= 500)).toEqual([]);
	});

	it("starts the walkthrough once the review returns when it never reached triage", async () => {
		const summarize = vi.spyOn(pipeline, "summarizeReview").mockResolvedValue(undefined);
		const actual = pipeline.reviewChangeset;
		vi.spyOn(pipeline, "reviewChangeset").mockImplementation(async (request) =>
			actual({ ...request, lensesStarted: () => {} }),
		);
		const io = { cwd: repo, env, stdout: () => {}, stderr: () => {}, color: false };

		expect(await review(io, "#7", { rerun: false })).toBe(0);

		expect(summarize).toHaveBeenCalledOnce();
	});

	it("prints and closes the storage only after a walkthrough a failed review started", async () => {
		const order: string[] = [];
		vi.spyOn(pipeline, "summarizeReview").mockImplementation(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			order.push("walkthrough ended");
		});
		vi.spyOn(pipeline, "reviewChangeset").mockImplementation(async (request) => {
			request.lensesStarted?.();
			throw new Error("lenses broke");
		});
		const close = pipeline.ReviewHarness.prototype.close;
		vi.spyOn(pipeline.ReviewHarness.prototype, "close").mockImplementation(async function (
			this: pipeline.ReviewHarness,
			...args
		) {
			order.push("closed");
			return close.apply(this, args);
		});
		const io = {
			cwd: repo,
			env,
			stdout: () => {
				order.push("output");
			},
			stderr: () => {},
			color: false,
		};

		await expect(review(io, "#7", { rerun: false, json: true })).rejects.toThrow("lenses broke");

		expect(order).toEqual(["walkthrough ended", "output", "closed"]);
	});
});

describe("CLI walkthrough credentials", { timeout: 60_000 }, () => {
	it("gives the summariser an unlock for its concrete light route", async () => {
		const summarize = vi.spyOn(pipeline, "summarizeReview").mockResolvedValue(undefined);
		const unlock = vi.spyOn(pipeline, "unlockCredentials").mockResolvedValue(undefined);
		const io = { cwd: repo, env, stdout: () => {}, stderr: () => {}, color: false };

		expect(await review(io, "#7", { rerun: false })).toBe(0);

		const { unlockModels } = summarize.mock.calls[0]![0];
		const before = unlock.mock.calls.length;
		await unlockModels!(["light-provider"]);
		expect(unlock.mock.calls.length).toBe(before + 1);
		await unlockModels!(["light-provider"]);
		expect(unlock.mock.calls.length).toBe(before + 2);
		expect(unlock.mock.calls.slice(before).map(([, providers]) => providers)).toEqual([
			["light-provider"],
			["light-provider"],
		]);
	});
});

describe("CLI walkthrough credential failure", { timeout: 60_000 }, () => {
	it("names the failing credential on stderr, stores the fixed note, and keeps the exit code", async () => {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		rmSync(repo, { recursive: true, force: true });
		repo = baseAndHead(
			{
				"src/a.ts": "export const a = 1;\n",
				"melian.yaml": "tiers:\n  full: [guardrails]\nmodels:\n  light:\n    model: faux/scripted\n",
			},
			{ "src/a.ts": "export const a = 2;\n" },
		);
		changeset = await Changeset.resolve(repo, "main...feature");
		writeFileSync(join(repo, "script.json"), "{}");
		env = { ...process.env, MELIAN_TEST_SCRIPT: join(repo, "script.json") };
		const state = pullRequestState();
		moveTo(state, changeset);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		vi.spyOn(targets, "gitHubFor").mockResolvedValue(provider);
		vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({
			pullRequest: await provider.pullRequest(7),
			changeset,
		});
		const failure = new pipeline.CredentialError(
			"commandFailed",
			"credential vault in /xdg/melian/secrets.yaml: its command failed (3)",
			{ credential: "vault", file: "/xdg/melian/secrets.yaml" },
		);
		const unlock = vi.spyOn(pipeline, "unlockCredentials").mockImplementation(async (_models, providers) => {
			if (providers.includes("faux")) throw failure;
		});
		let stderr = "";
		const io = {
			cwd: repo,
			env,
			stdout: () => {},
			stderr: (text: string) => {
				stderr += text;
			},
			color: false,
		};

		expect(await review(io, "#7", { rerun: false })).toBe(0);

		expect(unlock.mock.calls.map(([, providers]) => providers)).toContainEqual(["faux"]);
		expect(stderr).toContain("melian: credential vault in /xdg/melian/secrets.yaml: its command failed (3)\n");
		const note = (await recorded())?.walkthroughNotes?.[Revision.key(changeset.revision)];
		expect(note).toBe("No walkthrough available. The summariser failed.");
		expect(note).not.toContain("vault");
	});
});

describe("CLI publish walkthrough settings", { timeout: 60_000 }, () => {
	async function published(
		yaml: string,
		options: { walkthrough?: boolean },
		headYaml?: string,
		throughMain: { review?: boolean; publish?: boolean } = {},
		inspect?: (state: FakeState, output: string) => void,
	) {
		for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
		rmSync(repo, { recursive: true, force: true });
		repo = baseAndHead(
			{ "src/a.ts": "export const a = 1;\n", "melian.yaml": `tiers:\n  full: [guardrails]\n${yaml}` },
			{
				"src/a.ts": "export const a = 2;\n",
				...(headYaml === undefined ? {} : { "melian.yaml": `tiers:\n  full: [guardrails]\n${headYaml}` }),
			},
		);
		changeset = await Changeset.resolve(repo, "main...feature");
		const state = pullRequestState();
		moveTo(state, changeset);
		const provider = createGitHubProvider({
			owner: state.owner,
			repo: state.repo,
			token: "test-token",
			fetch: fakeGitHub(state),
		});
		vi.spyOn(targets, "gitHubFor").mockResolvedValue(provider);
		vi.spyOn(targets, "pullRequestChangeset").mockResolvedValue(changeset);
		vi.spyOn(targets, "currentBase").mockResolvedValue(changeset.revision.base);
		vi.spyOn(targets, "fetchedPullRequest").mockResolvedValue({
			pullRequest: await provider.pullRequest(7),
			changeset,
		});
		const script = join(repo, "script.json");
		writeFileSync(script, "{}");
		env = { ...process.env, MELIAN_TEST_SCRIPT: script };
		let output = "";
		const io = {
			cwd: repo,
			env,
			stdout: (text: string) => {
				output += text;
			},
			stderr: () => {},
			color: false,
		};
		// A head that edits melian.yaml draws a policy finding, which exits 3.
		expect(
			throughMain.review
				? await main(["review", "#7", ...(options.walkthrough === false ? ["--no-walkthrough"] : [])], io)
				: await review(io, "#7", { rerun: false }),
		).toBe(headYaml === undefined ? 0 : 3);
		// publish refuses a scripted run and reads the unscripted storage, so the scripted review moves there.
		copyFileSync(await storagePath(repo, changeset.id, env, true), await storagePath(repo, changeset.id, env, false));
		const { MELIAN_TEST_SCRIPT: _, ...clean } = env;
		expect(
			throughMain.publish
				? await main(["publish", "#7", ...(options.walkthrough === false ? ["--no-walkthrough"] : [])], {
						...io,
						env: clean,
					})
				: await publish({ ...io, env: clean }, "#7", options),
		).toBe(0);
		inspect?.(state, output);
		return state.ledgers[0]!.body;
	}

	it.each([false, true])("publishes with committed base writer trust %s", async (trustedWriters) => {
		await published(
			`trust: { writers: ${trustedWriters} }\n`,
			{},
			trustedWriters ? undefined : "trust: { writers: true }\n",
			{ publish: true },
			(state, output) => {
				expect(state.statuses).toHaveLength(2);
				expect(state.statuses.every(({ state }) => state === (trustedWriters ? "success" : "error"))).toBe(true);
				if (!trustedWriters) {
					const description = "not reviewed here: writers are not trusted; a trusted host sets this status";
					expect(
						state.statuses.every(
							(status) => status.description === `${description}; base ${changeset.revision.base}`,
						),
					).toBe(true);
					expect(output).toContain(`Status error: ${description}`);
				}
			},
		);
	});

	it("reads publish.walkthrough from the base revision and combines it with --no-walkthrough", async () => {
		const on = await published("", {});
		expect(on).toContain("Walkthrough");
		vi.restoreAllMocks();
		rmSync(repo, { recursive: true, force: true });
		expect(await published("", { walkthrough: false })).not.toContain("Walkthrough");
		vi.restoreAllMocks();
		rmSync(repo, { recursive: true, force: true });
		expect(await published("publish:\n  walkthrough:\n    enabled: false\n", {})).not.toContain("Walkthrough");
		vi.restoreAllMocks();
		rmSync(repo, { recursive: true, force: true });
		// The head turns the walkthrough back on; the base's setting still wins.
		expect(
			await published(
				"publish:\n  walkthrough:\n    enabled: false\n",
				{},
				"publish:\n  walkthrough:\n    enabled: true\n",
			),
		).not.toContain("Walkthrough");
	});

	it("stores no walkthrough when review gets --no-walkthrough from the command line", async () => {
		expect(await published("", { walkthrough: false }, undefined, { review: true })).not.toContain("Walkthrough");
		const doc = await recorded();
		expect(doc?.walkthroughs).toBeUndefined();
		expect(doc?.walkthroughNotes).toBeUndefined();
	});

	it("hides a stored walkthrough when publish gets --no-walkthrough from the command line", async () => {
		expect(await published("", { walkthrough: false }, undefined, { publish: true })).not.toContain("Walkthrough");
		expect((await recorded())?.walkthroughNotes?.[Revision.key(changeset.revision)]).toBeDefined();
	});
});

describe("CLI cold mutation run", { timeout: 60_000 }, () => {
	it.each([
		[{ rerun: false }, undefined],
		[{ rerun: false, cold: false }, undefined],
		[{ rerun: false, cold: true }, true],
	])("hands the checks a cold run only when the review asks for one: %j", async (options, cold) => {
		const checks = vi.spyOn(pipeline, "runChecks");
		const io = { cwd: repo, env, stdout: () => {}, stderr: () => {}, color: false };
		expect(await review(io, "#7", { ...options, walkthrough: false })).toBe(0);
		expect(checks).toHaveBeenCalledOnce();
		expect(checks.mock.calls[0]![1].cold).toBe(cold);
	});
});
