import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Changeset, type CheckRecord, defaultConfig, Lens, type MelianConfig, Revision } from "@melian-agent/core";
import { RecordedDecider } from "@melian-agent/decisions";
import {
	backgroundContext as context,
	createMemoryStorage,
	type Harness,
	ReviewHarness,
	reviewChangeset,
} from "@melian-agent/pipeline";
import {
	createFakeModels,
	type FakeModels,
	fauxAssistantMessage,
	scriptConversations,
} from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AdjudicationTaskInput } from "../src/adjudication.ts";
import { ReviewIndex } from "../src/review-index.ts";
import { gitIn, isolatedGitEnv, writeFiles } from "./fixtures/repo.ts";

// Pins which lenses a review selects for a change, and the band each covered path sets, through the account the
// review hands adjudication: a lens it does not select is skipped for no paths, and triage skips a selected lens only
// when every path it covers has a floor of skip.

const correctness = "You are the correctness reviewer";
const user = "export const user = 1;\n";
const skipFloor = "lenses:\n  correctness:\n    level: { floor: skip }\n";

let repo: string;
let fake: FakeModels;
let reviewHarness: ReviewHarness | undefined;
let harness: Harness;

beforeEach(() => {
	for (const [key, value] of Object.entries(isolatedGitEnv)) vi.stubEnv(key, value);
	repo = realpathSync(mkdtempSync(join(tmpdir(), "melian-coverage-")));
	fake = createFakeModels({ models: [{ id: "orchestrator" }, { id: "light" }, { id: "medium" }, { id: "heavy" }] });
});

afterEach(async () => {
	await reviewHarness?.close(context);
	reviewHarness = undefined;
	vi.unstubAllEnvs();
	rmSync(repo, { recursive: true, force: true });
});

// `main` holds `base`; `feature` moves each of `moves` and then writes `head`.
function repository(base: Record<string, string>, head: Record<string, string>, moves: [string, string][] = []) {
	gitIn(repo, "init", "--quiet", "--initial-branch=main");
	writeFiles(repo, base);
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", "base");
	gitIn(repo, "checkout", "--quiet", "-b", "feature");
	for (const [from, to] of moves) {
		writeFiles(repo, { [to]: "" });
		gitIn(repo, "mv", "--force", from, to);
	}
	writeFiles(repo, head);
	gitIn(repo, "add", "--all");
	gitIn(repo, "commit", "--quiet", "-m", "head");
}

const ran: CheckRecord[] = [
	{ name: "guardrails", status: "ran" },
	{ name: "static.biome", status: "ran" },
	{ name: "static.tsc", status: "ran" },
];

async function review(lensPaths?: string[], withDecider = true) {
	const route = (id: string) => ({ model: `${fake.ref(id).provider}/${id}` });
	const config: MelianConfig = {
		...defaultConfig,
		tiers: { ...defaultConfig.tiers, full: ["guardrails", "static", "lens.correctness"] },
		models: { light: route("light"), medium: route("medium"), heavy: route("heavy") },
		...(lensPaths === undefined ? {} : { lenses: { correctness: { paths: lensPaths } } }),
	};
	const decider = new RecordedDecider(
		{ triage: { version: "1", answers: { correctness: { distribution: { skip: 1 } } } } },
		{ name: "recorded", calibrated: true },
	);
	reviewHarness = await ReviewHarness.open(createMemoryStorage(), fake.review, {
		retry: false,
		...(withDecider ? { decider } : {}),
	});
	harness = reviewHarness.harness;
	await harness.root(context, { agent: { model: fake.ref("orchestrator") } });
	scriptConversations(fake, [{ match: correctness, replies: [fauxAssistantMessage("Done.")] }]);
	const changeset = await Changeset.resolve(repo, "main...feature");
	const policy = { kind: "revision", commit: changeset.revision.base } as const;
	return reviewChangeset({
		harness,
		changeset,
		config,
		lenses: await Lens.load(repo, policy, changeset.revision.paths()),
		standards: [],
		models: fake.review,
		checks: ran,
		...(withDecider ? { decider } : {}),
		policy,
	});
}

async function account(): Promise<{
	checks: { name: string; status: string; reason?: string }[];
	allowSkip: string[];
}> {
	const root = await harness.root(context);
	const index = await harness.snapshot(ReviewIndex, root.id, context);
	const revision = Revision.key({
		base: gitIn(repo, "merge-base", "main", "feature"),
		head: gitIn(repo, "rev-parse", "feature"),
	});
	const input = JSON.parse(index!.reviews[revision]!.adjudication!.input) as AdjudicationTaskInput;
	return {
		checks: input.checks.map(({ name, status, reason }) => ({
			name,
			status,
			...(reason === undefined ? {} : { reason }),
		})),
		allowSkip: input.allowSkip,
	};
}

// Triage's skip is no option under a floor above skip, so the lens runs at its default level and its record names the
// options the band offered.
const lensRan = {
	name: "lens.correctness",
	status: "ran",
	reason:
		"triage failed, so it ran at its default level: recorded answered correctness with an option it does not offer; its options are quick, careful, deep",
};
const triageSkipped = { name: "lens.correctness", status: "skipped", reason: "triage skipped it, as its floor allows" };

describe("the lenses a review selects, and the band of each", () => {
	it("skips a lens by triage under a nested melian.yaml whose floor is skip", async () => {
		repository({ "src/melian.yaml": skipFloor, "src/user.ts": user }, { "src/user.ts": "export const user = 2;\n" });

		await review();

		expect(await account()).toEqual({ checks: [...ran, triageSkipped], allowSkip: ["lens.correctness"] });
	});

	it("runs a selected lens when an untrusted review has no decider", async () => {
		repository({ "src/melian.yaml": skipFloor, "src/user.ts": user }, { "src/user.ts": "export const user = 2;\n" });

		await review(undefined, false);

		expect(await account()).toEqual({ checks: [...ran, { name: "lens.correctness", status: "ran" }], allowSkip: [] });
	});

	it("reads no floor from a nested melian.yaml beside the change", async () => {
		repository({ "docs/melian.yaml": skipFloor, "src/user.ts": user }, { "src/user.ts": "export const user = 2;\n" });

		await review();

		expect(await account()).toEqual({ checks: [...ran, lensRan], allowSkip: [] });
	});

	it("selects a lens whose paths hold only a renamed file's old path", async () => {
		repository({ "src/old/user.ts": user }, {}, [["src/old/user.ts", "src/new/user.ts"]]);

		await review(["src/old/**"]);

		expect(await account()).toEqual({ checks: [...ran, lensRan], allowSkip: [] });
	});

	it("skips no lens for no paths when the change leaves its paths", async () => {
		repository({ "src/user.ts": user, "docs/a.md": "a\n" }, { "docs/a.md": "b\n" });

		await review(["src/**"]);

		expect(await account()).toEqual({
			checks: [...ran, { name: "lens.correctness", status: "skipped", reason: "no paths" }],
			allowSkip: ["lens.correctness"],
		});
	});

	it("holds a lens selected through a renamed file's old path to its head path's band too", async () => {
		repository({ "src/old/melian.yaml": skipFloor, "src/old/user.ts": user }, {}, [
			["src/old/user.ts", "src/new/user.ts"],
		]);

		await review(["src/old/**"]);

		expect(await account()).toEqual({ checks: [...ran, lensRan], allowSkip: [] });
	});

	it("skips a lens selected through a renamed file when both its paths have a floor of skip", async () => {
		repository({ "src/old/melian.yaml": skipFloor, "src/new/melian.yaml": skipFloor, "src/old/user.ts": user }, {}, [
			["src/old/user.ts", "src/new/user.ts"],
		]);

		await review(["src/old/**"]);

		expect(await account()).toEqual({ checks: [...ran, triageSkipped], allowSkip: ["lens.correctness"] });
	});
});
