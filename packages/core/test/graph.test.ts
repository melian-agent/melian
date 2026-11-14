import { GraphSnapshot } from "@melian-agent/core";
import { expect, it } from "vitest";

const parts = { tree: "a".repeat(40), version: "0.4.27", binary: "b".repeat(64), config: "c".repeat(64) };

it("rejects invalid graph key syntax and unknown key fields", () => {
	for (const invalid of [
		{ ...parts, tree: "HEAD" },
		{ ...parts, version: "latest" },
		{ ...parts, binary: "binary" },
		{ ...parts, config: "config" },
		{ ...parts, extra: true },
	])
		expect(() => GraphSnapshot.key(invalid)).toThrow("Invalid graph key parts");
});

it("validates stored snapshot syntax before comparing graph identities", () => {
	const files = {
		"facts.jsonl": "",
		"insights.json": "[]",
		"receipt.json": JSON.stringify({
			format_version: 1,
			enola_version: parts.version,
			snapshot_id: `sha256:${"d".repeat(64)}`,
		}),
	};
	const snapshot = GraphSnapshot.create(parts, files);
	expect(GraphSnapshot.parse(JSON.stringify(snapshot.toJSON()), files, parts).files()).toEqual(files);
	expect(() =>
		GraphSnapshot.parse(JSON.stringify({ ...snapshot.toJSON(), snapshotId: "invalid" }), files, parts),
	).toThrow("Invalid graph entry");
});

it("refuses an entry whose artifact hashes disagree with its files, though the rest agrees", () => {
	const files = {
		"facts.jsonl": "",
		"insights.json": "[]",
		"receipt.json": JSON.stringify({
			format_version: 1,
			enola_version: parts.version,
			snapshot_id: `sha256:${"d".repeat(64)}`,
		}),
	};
	const entry = GraphSnapshot.create(parts, files).toJSON();
	const artifacts = { ...entry.artifacts, "insights.json": "0".repeat(64) };
	expect(() => GraphSnapshot.parse(JSON.stringify({ ...entry, artifacts }), files, parts)).toThrow(
		"Graph entry does not match its inputs or artifacts",
	);
});
