import type { CheckRecord } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import type { CheckRunRecord } from "../src/checks.ts";
import { ReviewRecords, withheld } from "../src/review-records.ts";
import { verifierVersion } from "../src/verification-instructions.ts";

// The producer applies each class core's schema checks, so a record it builds from the head's text is one a reader takes.
const records = ReviewRecords.of("c".repeat(64), { base: "a".repeat(40), head: "b".repeat(40) });
const payload = (record: { toJSON(): { payload: unknown } }) => record.toJSON().payload as Record<string, unknown>;
const hash = (digit: string) => digit.repeat(64);
const snapshotId = `sha256:${hash("e")}`;
const snapshot = {
	commit: "b".repeat(40),
	snapshotId,
	receipt: JSON.stringify({ format_version: 1, snapshot_id: snapshotId, enola_version: "0.4.37" }),
	cacheKey: hash("f"),
	coverage: { graph: hash("1"), review: hash("2"), test: hash("3") },
};
const ran = (snapshots: unknown[]): CheckRunRecord =>
	({ name: "static.enola", status: "ran", version: "0.4.37", findings: 0, notes: [], snapshots }) as CheckRunRecord;
const verifier = (check: Partial<CheckRecord>) =>
	payload(
		records.verification("f".repeat(64), {
			claims: [],
			dismissals: [],
			outcomes: [],
			check: { name: "verifier", status: "ran", ...check } as CheckRecord,
		}),
	).check as Record<string, unknown>;

describe("a record's classed fields as the producer writes them", () => {
	it("keeps the verifier's own version", () => {
		expect(verifier({ version: verifierVersion }).version).toBe(verifierVersion);
	});

	it("withholds a decided check's version that is not a tool's, and keeps one that is", () => {
		const decided = (version: string) =>
			(
				payload(
					records.account({
						checks: [],
						records: [],
						filled: [{ name: "static.biome", status: "failed", version }],
						allowSkip: [],
						producers: [],
						resolutionPolicy: null,
					}),
				).filled as Record<string, unknown>[]
			)[0]?.version;
		expect(decided("ghp_token")).toBe(withheld);
		expect(decided("2.0.0")).toBe("2.0.0");
	});

	it("drops a decided check's coverage ID that is not a hash, one ID at a time", () => {
		const coverage = { graph: hash("1"), review: hash("2"), test: hash("3") };
		expect(verifier({ coverage }).coverage).toEqual(coverage);
		expect(verifier({ coverage: { ...coverage, graph: "ghp_token" } }).coverage).toEqual({
			...coverage,
			graph: null,
		});
		expect(verifier({ coverage: { ...coverage, review: "ghp_token" } }).coverage).toEqual({
			...coverage,
			review: null,
		});
		expect(verifier({ coverage: { ...coverage, test: "ghp_token" } }).coverage).toEqual({ ...coverage, test: null });
		expect(verifier({ coverage: {} }).coverage).toEqual({ graph: null, review: null, test: null });
	});

	it("withholds a check whose snapshot names a commit that is not a git object ID", () => {
		const result = (commit: string) =>
			payload(records.check("e".repeat(64), ran([{ ...snapshot, commit }]), [])).result as Record<string, unknown>;
		const refused = { name: "static.enola", status: "failed", reason: "withheld", error: withheld };
		expect(result("ghp_token")).toEqual(refused);
		expect(result("b".repeat(39))).toEqual(refused);
		expect(result("b".repeat(40)).snapshots).toEqual([snapshot]);
		expect(result(hash("b")).snapshots).toEqual([{ ...snapshot, commit: hash("b") }]);
	});
});
