import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "@melian-agent/core";
import { describe, expect, it } from "vitest";
import { createReviewModels } from "../src/credentials.ts";
import { modelsOf } from "../src/models.ts";
import {
	type Attack,
	boundProbeEvidence,
	type ProbeEvidence,
	probeEvidenceBudget,
	probeEvidenceCutWording,
	probingLimits,
	renderProbeEvidence,
	type StoredProbeResult,
} from "../src/probing.ts";

const nonce = "0123456789abcdef01234567";

const result = (output: string, exitCode = 1): StoredProbeResult => ({
	exitCode,
	signal: null,
	output,
	truncated: false,
	timedOut: false,
});

// A text of `bytes` bytes whose first and last lines say which part it is, so a test can tell the ends survived a cut.
const text = (name: string, bytes: number) => {
	const head = `${name} begins\n`;
	const tail = `\n${name} ends`;
	return `${head}${"x".repeat(bytes - head.length - tail.length)}${tail}`;
};

const plan = (name: string): Attack[] =>
	Array.from({ length: probingLimits.attacks }, (_, index) => ({
		target: text(`${name} target ${index}`, probingLimits.target),
		reason: text(`${name} reason ${index}`, probingLimits.reason),
		passing: text(`${name} passing ${index}`, probingLimits.outcome),
		failing: text(`${name} failing ${index}`, probingLimits.outcome),
	}));

// A merged claim's evidence with every part a model or the head wrote at its limit: the plan, the script, files holding
// all the bytes a probe may hold, and both runs' output.
const atLimits = (label: string): ProbeEvidence => ({
	label,
	probe: {
		id: `p-${label}`,
		attack: 1,
		plan: plan(label),
		probe: {
			attack: 1,
			script: text(`${label} script`, probingLimits.script),
			files: Array.from({ length: probingLimits.files }, (_, index) => ({
				path: `${label}/file${index}.ts`,
				text: text(`${label} file ${index}`, probingLimits.fileBytes / probingLimits.files),
			})),
			result: result(text(`${label} prober output`, probingLimits.output)),
			milliseconds: 5,
		},
	},
	again: { result: result(text(`${label} melian output`, probingLimits.output)), milliseconds: 4 },
});

const small = (label: string, script: string): ProbeEvidence => ({
	label,
	probe: {
		id: `p-${label}`,
		attack: 1,
		plan: [{ target: "t", reason: "r", passing: "p", failing: "f" }],
		probe: { attack: 1, script, files: [], result: result("out"), milliseconds: 5 },
	},
	again: undefined,
});

const bytes = (blocks: readonly string[]) => Buffer.byteLength(blocks.join("\n\n"));
const whole = (evidence: readonly ProbeEvidence[]) =>
	evidence.map(({ label, probe, again }) => renderProbeEvidence(label, probe, again, nonce));

// Evidence whose whole rendering is exactly `size` bytes: three small claims, the first padded.
const sized = (size: number) => {
	const unpadded = [small("c1", ""), small("c2", "short"), small("c3", "short")];
	return [small("c1", "s".repeat(size - bytes(whole(unpadded)))), ...unpadded.slice(1)];
};

describe("boundProbeEvidence", () => {
	it("renders evidence of exactly the budget whole, and cuts evidence one byte past it to fit", () => {
		const at = sized(probeEvidenceBudget);
		expect(bytes(whole(at))).toBe(probeEvidenceBudget);
		expect(boundProbeEvidence(at, nonce)).toEqual(whole(at));

		const past = sized(probeEvidenceBudget + 1);
		const bound = boundProbeEvidence(past, nonce);
		expect(bound).not.toEqual(whole(past));
		expect(bytes(bound)).toBeLessThanOrEqual(probeEvidenceBudget);
		expect(bound[0]).toContain(probeEvidenceCutWording.conclude);
		// Only the long script was cut; the short claims render as they would alone.
		expect(bound.slice(1)).toEqual(whole(past).slice(1));
	});

	it("fits three merged claims at every limit within the budget, keeping each cut part's ends", () => {
		const evidence = [atLimits("c1"), atLimits("c2"), atLimits("c3")];
		expect(bytes(whole(evidence))).toBeGreaterThan(3 * probeEvidenceBudget);
		const bound = boundProbeEvidence(evidence, nonce);
		expect(bound).toHaveLength(3);
		expect(bytes(bound)).toBeLessThanOrEqual(probeEvidenceBudget);
		// The cut fills the budget rather than cut more than it must.
		expect(bytes(bound)).toBeGreaterThan(probeEvidenceBudget - 4096);
		for (const [index, block] of bound.entries()) {
			const label = `c${index + 1}`;
			for (const part of [`${label} script`, `${label} prober output`, `${label} melian output`]) {
				expect(block).toContain(`${part} begins`);
				expect(block).toContain(`${part} ends`);
			}
			expect(block).toContain(`${label} target 0 begins`);
			expect(block).toContain(`${label} failing ${probingLimits.attacks - 1} ends`);
			expect(block).toContain(probeEvidenceCutWording.conclude);
			expect(block).toMatch(/\[Melian cut \d+ bytes here\]/);
		}
	});

	it("cuts the longest parts first and leaves shorter ones whole", () => {
		const long = small("c1", text("long script", 200_000));
		const short = small("c2", text("short script", 2_000));
		const bound = boundProbeEvidence([long, short], nonce);
		expect(bytes(bound)).toBeLessThanOrEqual(probeEvidenceBudget);
		expect(bound[1]).toBe(renderProbeEvidence("c2", short.probe, undefined, nonce));
		expect(bound[0]).toContain("long script begins");
		expect(bound[0]).toContain("long script ends");
	});

	it("says outside the boundary which parts were cut and by how much, naming a file by its number", () => {
		const evidence: ProbeEvidence = {
			label: "c1",
			probe: {
				id: "p1",
				attack: 1,
				plan: [{ target: "t", reason: "r", passing: "p", failing: "f" }],
				probe: {
					attack: 1,
					script: "short",
					files: [
						{ path: "secret/name.ts", text: "a" },
						{ path: "other/name.ts", text: text("file", 200_000) },
					],
					result: result("out"),
					milliseconds: 5,
				},
			},
			again: { refused: "no sandbox" },
		};
		const [block] = boundProbeEvidence([evidence], nonce);
		const outside = block!.slice(0, block!.indexOf(`<untrusted-${nonce}`));
		const note = outside.split("\n\n").find((paragraph) => paragraph.startsWith("Melian cut"));
		expect(note).toMatch(
			new RegExp(
				`^Melian cut this claim's evidence to fit the ${probeEvidenceBudget} bytes of probe evidence a verifier is shown: file 2, cut by \\d+ of its 200000 bytes\\. `,
			),
		);
		const amount = Number(/file 2, cut by (\d+)/.exec(note!)![1]);
		expect(block).toContain(`[Melian cut ${amount} bytes here]`);
		expect(outside).not.toContain("name.ts");
		expect(outside).toContain(probeEvidenceCutWording.conclude);
	});

	it("cuts at a character boundary, never inside one", () => {
		const evidence = small("c1", "é".repeat(100_000));
		const [block] = boundProbeEvidence([evidence], nonce);
		expect(block).not.toContain("\u{FFFD}");
		expect(Buffer.byteLength(block!)).toBeLessThanOrEqual(probeEvidenceBudget);
	});

	it("leaves the records it renders whole", () => {
		const evidence = [atLimits("c1"), atLimits("c2")];
		const before = structuredClone(evidence);
		boundProbeEvidence(evidence, nonce);
		expect(evidence).toEqual(before);
	});
});

describe("probeEvidenceBudget", () => {
	// Coordinator's choice for issue #357: twice the budget in tokens leaves the verifier's instructions, the claims and
	// its reads room beside the evidence, counting a byte of evidence as at most one token.
	it("fits twice over in the context of every model the committed verifier route may answer from", async () => {
		const repo = fileURLToPath(new URL("../../..", import.meta.url));
		const { config } = await loadConfig(repo, { kind: "revision", commit: "HEAD" }, "");
		const route = config.models.verifier!;
		const named = [route.model, ...(route.fallbacks ?? []), ...(route.accept ?? [])];
		expect(named.length).toBeGreaterThan(1);
		const catalog = modelsOf(createReviewModels({ authPath: join(tmpdir(), "melian-no-auth.json") })).getModels();
		const small = [...new Set(named)].filter((name) => {
			const model = catalog.find(({ provider, id }) => `${provider}/${id}` === name);
			return model === undefined || model.contextWindow < 2 * probeEvidenceBudget;
		});
		expect(small).toEqual([]);
	});
});
