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

// A store this branch's code wrote at version 2 of the probing document, whose prober reported a finding on a probe
// that exited 137 on its own.
const fixture = join(import.meta.dirname, "fixtures", "probing-v2");
const recorded = JSON.parse(readFileSync(join(fixture, "recorded.json"), "utf8")) as {
	revision: string;
	lensTask: { result: Record<string, { probing: { prober: number } }> };
};
const exited = { exitCode: 137, signal: null, output: "", truncated: false, timedOut: false };

let directory: string;
let harness: ReviewHarness | undefined;

beforeEach(() => {
	directory = mkdtempSync(join(tmpdir(), "melian-probing-v2-"));
	copyFileSync(join(fixture, "state.sqlite"), join(directory, "state.sqlite"));
});

afterEach(async () => {
	await harness?.close();
	harness = undefined;
	rmSync(directory, { recursive: true, force: true });
});

describe("a store written at version 2 of the probing document", () => {
	it("keeps the probe's own exit 137, and reads the attack its finding rests on as answered", async () => {
		const storage = await openSqliteStorage(join(directory, "state.sqlite"));
		harness = await openReviewHarness(storage, createFakeModels().review, { retry: false });
		const reviewer = harness.harness;
		const [run] = Object.values(recorded.lensTask.result);
		const probing = await reviewer.snapshot(ProbingDocument, run!.probing.prober as ConversationId, context);
		const probes = Object.values(probing?.probes ?? {});
		expect(probes.map(({ attack, result }) => ({ attack, result }))).toEqual([{ attack: 1, result: exited }]);
		expect(Object.values(probing?.findings ?? {})).toEqual(Object.keys(probing?.probes ?? {}));
		expect(probing?.answered).toEqual([1]);
		expect(probeConclusive(exited)).toBe(true);
		const root = await reviewer.root(context);
		const reruns = Object.values((await reviewer.snapshot(ProbeReruns, root.id, context))!.runs[recorded.revision]!);
		expect(reruns).toEqual([{ result: exited, milliseconds: expect.any(Number) }]);
	});
});
