import { describe, expect, it } from "vitest";
import { canonicalJson, Finding, RecordError, SightingBudget, snippetHash } from "../src/index.ts";

function guardrail(file: number, line: number, pad: string): Finding {
	const path = `packages/p${file}/package.json`;
	return Finding.create({
		rule: "guardrail/policy-change-review",
		message: `Review the change to ${path}.`,
		file: path,
		startLine: line,
		discriminator: "analyser",
		cause: "introduced",
		trigger: { file: path, index: line, hash: snippetHash(`blob:${file}:${line}`) },
		severity: "P1",
		explanation: { what: `Changes ${path}. ${pad}`, whyHere: "Policy.", whatToDo: "Read it." },
		source: { check: "guardrails" },
		guardrail: { notice: "analyser" },
	});
}

const size = (findings: readonly Finding[]) => Buffer.byteLength(canonicalJson(findings.map((f) => f.toJSON())));

function fitted(budget: number, findings: readonly Finding[]): number | undefined {
	try {
		return size(new SightingBudget(budget).fit(findings));
	} catch (error) {
		if (error instanceof RecordError) return undefined;
		throw error;
	}
}

describe("the fit over a sweep of rooms", { timeout: 120_000 }, () => {
	// One finding per file, as IDs are unique in a record, with pads of uneven length.
	const findings = Array.from({ length: 40 }, (_, index) => guardrail(index, 1, "p".repeat((index * 37) % 300)));

	it("never gives a smaller result in a larger room, and every result fits its room", () => {
		const whole = size(findings);
		let previous = 0;
		const drops: number[] = [];
		for (let room = Math.floor(whole * 0.6); room <= whole + 2; room += 7) {
			const result = fitted(room, findings);
			if (result === undefined) continue;
			expect(result).toBeLessThanOrEqual(room);
			if (result < previous) drops.push(room);
			previous = result;
		}
		expect(drops).toEqual([]);
	});

	it("gives the same bytes for the same findings in any order", () => {
		const room = size(findings) - 500;
		const reversed = [...findings].reverse();
		const ordered = (list: readonly Finding[]) =>
			canonicalJson(
				new SightingBudget(room)
					.fit(list)
					.map((f) => f.toJSON())
					.sort((a, b) => (a.properties.id < b.properties.id ? -1 : 1)),
			);
		expect(ordered(reversed)).toBe(ordered(findings));
	});
});
