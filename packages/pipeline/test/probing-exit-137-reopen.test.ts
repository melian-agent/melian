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
		// Main's prober reported a finding on attack 1's probe, which version 3 reads as answering attack 1.
		expect(probing?.answered).toEqual([1]);
		const root = await reviewer.root(context);
		const reruns = Object.values((await reviewer.snapshot(ProbeReruns, root.id, context))!.runs[recorded.revision]!);
		expect(reruns).toEqual([{ result: ended, milliseconds: expect.any(Number) }]);
		expect(probeConclusive(ended)).toBe(false);
	});
});

// Bubblewrap reports a signal n as exit 128 + n, and n is 1 to 64, the most Linux has, so exits 128 and 193 to 255 are
// the probe's own.
describe("reading a version-1 probe result", () => {
	const result = (exitCode: number | null, signal: string | null = null) => ({
		exitCode,
		signal,
		output: "out",
		truncated: false,
		timedOut: false,
	});
	const cases: [ReturnType<typeof result>, ReturnType<typeof result>][] = [
		[result(0), result(0)],
		[result(1), result(1)],
		[result(128), result(128)],
		[result(129), result(null)],
		[result(137), result(null)],
		[result(192), result(null)],
		[result(193), result(193)],
		[result(255), result(255)],
		[result(137, "SIGKILL"), result(137, "SIGKILL")],
		[result(null, "SIGKILL"), result(null, "SIGKILL")],
		[result(null), result(null)],
	];

	it("reads an exit from 129 to 192 with no signal as an ending with no record of how, in the prober's record", () => {
		const migrate = ProbingDocument.definition.migrate!;
		const probe = { attack: 1, script: "s", files: [], milliseconds: 1 };
		for (const [stored, read] of cases)
			expect(migrate({ plan: [], probes: { p1: { ...probe, result: stored } } }, 1)).toEqual({
				plan: [],
				probes: { p1: { ...probe, result: read } },
			});
		expect(migrate({ plan: [] }, 1)).toEqual({ plan: [] });
	});

	it("leaves a version-2 result as it was, since version 2 records a signal apart", () => {
		const migrate = ProbingDocument.definition.migrate!;
		const probe = { attack: 1, script: "s", files: [], milliseconds: 1 };
		for (const [stored] of cases)
			expect(migrate({ plan: [], probes: { p1: { ...probe, result: stored } } }, 2)).toEqual({
				plan: [],
				probes: { p1: { ...probe, result: stored } },
			});
	});
	it("reads the same in the review's reruns, and keeps a refused rerun", () => {
		const migrate = ProbeReruns.definition.migrate!;
		for (const [stored, read] of cases)
			expect(
				migrate({ runs: { r: { k: { result: stored, milliseconds: 1 }, n: { refused: "no sandbox" } } } }, 1),
			).toEqual({ runs: { r: { k: { result: read, milliseconds: 1 }, n: { refused: "no sandbox" } } } });
	});
});

// Versions 1 and 2 kept only the latest probe of each finding, so a finding reported again on another attack's probe
// forgot the first; version 3 keeps the attacks a finding answered apart.
describe("reading the attacks an older prober's findings answered", () => {
	const probe = (attack: number) => ({
		attack,
		script: "s",
		files: [],
		result: { exitCode: 1, signal: null, output: "", truncated: false, timedOut: false },
		milliseconds: 1,
	});
	const probes = { p1: probe(1), p2: probe(2), p3: probe(2), p4: probe(3) };

	it("reads each attack a stored finding rests on, once, at either version", () => {
		const migrate = ProbingDocument.definition.migrate!;
		for (const version of [1, 2])
			expect(migrate({ probes, findings: { a: "p1", b: "p2", c: "p3" } }, version)).toStrictEqual({
				probes,
				findings: { a: "p1", b: "p2", c: "p3" },
				answered: [1, 2],
			});
	});

	it("reads no attack answered where no finding names a probe that ran", () => {
		const migrate = ProbingDocument.definition.migrate!;
		expect(migrate({ probes, findings: { a: "p9" } }, 2)).toStrictEqual({ probes, findings: { a: "p9" } });
		expect(migrate({ probes }, 2)).toStrictEqual({ probes });
		expect(migrate({ findings: { a: "p1" } }, 2)).toStrictEqual({ findings: { a: "p1" } });
	});
});
