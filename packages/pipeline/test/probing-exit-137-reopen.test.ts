import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	backgroundContext as context,
	openReviewHarness,
	openSqliteStorage,
	type ReviewHarness,
} from "@melian-agent/pipeline";
import { createFakeModels } from "@melian-agent/pipeline/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ConversationId } from "../src/harness.ts";
import { ProbeReruns, ProbingDocument, probeConclusive } from "../src/probing.ts";

// A store main wrote, whose bubblewrap runner recorded a probe a signal ended as exit 137 with no signal.
const fixture = join(import.meta.dirname, "fixtures", "probing-exit-137");
const recorded = JSON.parse(readFileSync(join(fixture, "recorded.json"), "utf8")) as {
	revision: string;
	lensTask: { result: Record<string, { probing: { prober: number } }> };
};
const ended = { exitCode: null, signal: null, output: "", truncated: false, timedOut: false };

let directory: string;
let harness: ReviewHarness | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "melian-probing-137-"));
	copyFileSync(join(fixture, "state.sqlite"), join(directory, "state.sqlite"));
});

afterEach(async () => {
	await harness?.close();
	harness = undefined;
	rmSync(directory, { recursive: true, force: true });
});

// Codex's review of pull request #532: main stored a signal as exit 128 plus its number, and the current code read
// that exit as a conclusive failure, so a probe a signal ended confirmed a claim.
describe("a probe main recorded as exit 137 with no signal", () => {
	it("reads as a probe that ended with no record of how, in the prober's record and the review's rerun", async () => {
		const storage = await openSqliteStorage(join(directory, "state.sqlite"));
		harness = await openReviewHarness(storage, createFakeModels().review, { retry: false });
		const reviewer = harness.harness;
		const [run] = Object.values(recorded.lensTask.result);
		const probing = await reviewer.snapshot(ProbingDocument, run!.probing.prober as ConversationId, context);
		const probes = Object.values(probing?.probes ?? {});
		expect(probes.map(({ result }) => result)).toEqual([ended]);
		const root = await reviewer.root(context);
		const reruns = Object.values((await reviewer.snapshot(ProbeReruns, root.id, context))!.runs[recorded.revision]!);
		expect(reruns).toEqual([{ result: ended, milliseconds: expect.any(Number) }]);
		expect(probeConclusive(ended)).toBe(false);
	});
});
