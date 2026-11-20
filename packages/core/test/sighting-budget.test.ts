import {
	Adjudication,
	canonicalJson,
	defaultConfig,
	envelopeAllowance,
	Finding,
	recordLimit,
	SightingBudget,
	snippetHash,
} from "@melian-agent/core";
import { describe, expect, it } from "vitest";

type Severity = "P0" | "P1" | "P2" | "P3";

// A policy notice as guardrails writes one for a workspace manifest, its What made long by the scripts it names.
function notice(
	index: number,
	options: { severity?: Severity; what?: string; whyHere?: string; message?: string } = {},
): Finding {
	const path = `packages/p${String(index).padStart(4, "0")}/package.json`;
	return Finding.create({
		rule: "guardrail/policy-change-review",
		message: options.message ?? `Review the change to ${path}, which configures the packages Biome and tsc load.`,
		file: path,
		startLine: 1,
		discriminator: "analyser",
		cause: "introduced",
		trigger: { file: path, index: 0, hash: snippetHash(`blob:${index}`) },
		severity: options.severity ?? "P1",
		explanation: {
			what:
				options.what ??
				`This revision changes ${path}, which configures the packages Biome and tsc load. It changes the npm scripts ${"s".repeat(2000)}.`,
			whyHere:
				options.whyHere ??
				"The head's configuration drives the static run on the head, so this change decides how the head's own results are judged.",
			whatToDo: `Have a maintainer read the change to ${path}, or land it in its own pull request first.`,
		},
		source: { check: "guardrails" },
		guardrail: { notice: "analyser" },
	});
}

const note = (files: number) =>
	`Melian left out the detail for ${files} more ${files === 1 ? "file" : "files"} to keep this record under its limit; \`git diff\` shows ${files === 1 ? "that file" : "those files"}.`;
const byId = (each: readonly Finding[]) => [...each].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
const bytes = (each: readonly Finding[]) => Buffer.byteLength(canonicalJson(byId(each).map((f) => f.toJSON())));
const size = (finding: Finding) => Buffer.byteLength(canonicalJson(finding.toJSON()));
const kept = (each: readonly Finding[]) =>
	each.map((finding) => ({
		id: finding.id,
		rule: finding.ruleId,
		severity: finding.properties.severity,
		resolution: finding.properties.resolution,
		path: finding.properties.path,
		region: finding.locations[0]!.physicalLocation.region,
		trigger: finding.properties.trigger,
		discriminator: finding.properties.discriminator,
		message: finding.message.text,
		whatToDo: finding.properties.explanation.whatToDo,
	}));
const refusal = (budget: number, each: readonly Finding[]) => {
	try {
		new SightingBudget(budget).fit(each);
	} catch (error) {
		return error;
	}
	return undefined;
};
// The fewest bytes `fit` brings the findings to: the smallest budget it neither refuses nor passes.
function floor(each: readonly Finding[]): number {
	const fits = (budget: number) =>
		refusal(budget, each) === undefined && bytes(new SightingBudget(budget).fit(each)) <= budget;
	let low = 0;
	let high = bytes(each);
	while (low < high) {
		const middle = Math.floor((low + high) / 2);
		if (fits(middle)) high = middle;
		else low = middle + 1;
	}
	return low;
}

// A deterministic shuffle.
function shuffled<T>(items: readonly T[], seed: number): T[] {
	const copy = [...items];
	let state = seed;
	for (let index = copy.length - 1; index > 0; index--) {
		state = (state * 1103515245 + 12345) % 2 ** 31;
		const other = state % (index + 1);
		[copy[index], copy[other]] = [copy[other]!, copy[index]!];
	}
	return copy;
}

const findings = Array.from({ length: 12 }, (_, index) => notice(index, { severity: index % 3 === 0 ? "P3" : "P1" }));

describe("a record's sighting budget", () => {
	it("is the store's record limit less the envelope's allowance", () => {
		expect(SightingBudget.checkRecord.bytes).toBe(recordLimit - envelopeAllowance);
	});

	it("leaves findings that fit it exactly as they are", () => {
		const exact = bytes(findings);
		expect(new SightingBudget(exact).fit(findings)).toEqual(findings);
	});

	it("abridges the last finding in ID order one byte past it, naming one more file", () => {
		const exact = bytes(findings);
		const fitted = new SightingBudget(exact - 1).fit(findings);
		const last = byId(findings).at(-1)!;
		const changed = fitted.filter((finding, index) => finding !== findings[index]);
		expect(changed.map((finding) => finding.id)).toEqual([last.id]);
		expect(changed[0]!.properties.explanation).toEqual({
			what: last.message.text,
			whyHere: note(1),
			whatToDo: last.properties.explanation.whatToDo,
		});
		expect(bytes(fitted)).toBeLessThanOrEqual(exact - 1);
		expect(kept(fitted)).toEqual(kept(findings));
	});

	it("keeps detail while the full findings so far and every later one abridged fit, and counts the rest's files", () => {
		const budget = Math.floor((bytes(findings) + floor(findings)) / 2);
		const fitted = new SightingBudget(budget).fit(findings);
		expect(bytes(fitted)).toBeLessThanOrEqual(budget);
		const order = fitted
			.map((finding, index) => [finding, index] as const)
			.sort(([a], [b]) => (a.id < b.id ? -1 : 1));
		const abridged = order.map(([finding, index]) => finding !== findings[index]);
		const cut = abridged.indexOf(true);
		expect(cut).toBeGreaterThan(0);
		expect(abridged.slice(cut).every(Boolean)).toBe(true);
		expect(order.slice(cut).map(([finding]) => finding.properties.explanation.whyHere)).toEqual(
			new Array(findings.length - cut).fill(note(findings.length - cut)),
		);
		// One more finding with its detail would not fit.
		const more = order.map(([finding, index], at) => (at === cut ? findings[index]! : finding));
		expect(bytes(more)).toBeGreaterThan(budget);
		expect(kept(fitted)).toEqual(kept(findings));
	});

	it("gives the same bytes and IDs for the same findings, in any order", () => {
		const budget = Math.floor((bytes(findings) + floor(findings)) / 2);
		const once = canonicalJson(byId(new SightingBudget(budget).fit(findings)).map((f) => f.toJSON()));
		for (const order of [[...findings].reverse(), ...[1, 7, 42, 1234].map((seed) => shuffled(findings, seed))]) {
			expect(canonicalJson(byId(new SightingBudget(budget).fit(order)).map((f) => f.toJSON()))).toBe(once);
		}
	});

	it("gives the same bytes for two findings of one ID but different detail, in either order", () => {
		const one = notice(1, { what: `Changes it. ${"a".repeat(3000)}` });
		const twin = Finding.parse({
			...one.toJSON(),
			properties: {
				...one.properties,
				explanation: { ...one.properties.explanation, what: `different ${"b".repeat(10)}` },
			},
		});
		expect(twin.id).toBe(one.id);
		const rest = Array.from({ length: 20 }, (_, index) => notice(index + 10));
		const all = [one, twin, ...rest];
		const budget = Math.floor(bytes(all) * 0.6);
		const render = (each: readonly Finding[]) =>
			each
				.map((f) => canonicalJson(f.toJSON()))
				.sort()
				.join("\n");
		expect(render(new SightingBudget(budget).fit([twin, one, ...rest]))).toBe(
			render(new SightingBudget(budget).fit(all)),
		);
	});

	it("abridges every finding at its floor", () => {
		const lowest = floor(findings);
		const fitted = new SightingBudget(lowest).fit(findings);
		expect(bytes(fitted)).toBe(lowest);
		expect(fitted.every((finding, index) => finding !== findings[index])).toBe(true);
		expect(new Set(fitted.map((finding) => finding.properties.explanation.whyHere))).toEqual(
			new Set([note(findings.length)]),
		);
		expect(kept(fitted)).toEqual(kept(findings));
	});

	it("abridges one finding whose What alone is past the budget, and it fits", () => {
		const huge = notice(0, { what: `Changes it. ${"z".repeat(5 * 1024 * 1024)}` });
		const fitted = SightingBudget.checkRecord.fit([huge]);
		expect(bytes(fitted)).toBeLessThanOrEqual(SightingBudget.checkRecord.bytes);
		expect(kept(fitted)).toEqual(kept([huge]));
	});

	it("never returns a trimmed finding larger than the one it was given, in UTF-8 bytes", () => {
		const longHeadline = notice(100, { message: `Review ${"h".repeat(4000)}`, what: "Changes it." });
		const shortWhyHere = notice(101, { what: `Changes it. ${"w".repeat(40)}`, whyHere: "Policy." });
		// Fewer characters in What than in the headline, but more bytes in the headline.
		const multiByte = notice(102, { message: `Review ${"€".repeat(400)}`, what: "é".repeat(500) });
		const all = [longHeadline, shortWhyHere, multiByte, ...Array.from({ length: 20 }, (_, index) => notice(index))];
		const lowest = floor(all);
		for (const budget of [lowest, Math.floor((lowest + bytes(all)) / 2), bytes(all) - 1]) {
			const fitted = new SightingBudget(budget).fit(all);
			expect(bytes(fitted)).toBeLessThanOrEqual(budget);
			fitted.forEach((finding, index) => {
				expect(size(finding)).toBeLessThanOrEqual(size(all[index]!));
			});
		}
		const fitted = new SightingBudget(lowest).fit(all);
		expect(fitted[0]!.properties.explanation.what).toBe("Changes it.");
		// Abridging this one would make it larger, so it keeps its detail.
		expect(fitted[1]).toBe(shortWhyHere);
		expect(fitted[2]!.properties.explanation).toEqual({
			what: multiByte.properties.explanation.what,
			whyHere: note(22),
			whatToDo: multiByte.properties.explanation.whatToDo,
		});
	});

	it("measures multi-byte detail in bytes at the bound and one past it", () => {
		const wide = Array.from({ length: 50 }, (_, index) => notice(index, { what: "€".repeat(1500) }));
		const exact = bytes(wide);
		expect(new SightingBudget(exact).fit(wide)).toEqual(wide);
		const fitted = new SightingBudget(exact - 1).fit(wide);
		expect(bytes(fitted)).toBeLessThanOrEqual(exact - 1);
		expect(fitted.filter((f, index) => f !== wide[index])).toHaveLength(1);
	});

	it("measures multi-byte headlines in bytes when it abridges", () => {
		const wide = Array.from({ length: 200 }, (_, index) =>
			notice(index, { message: `Review \u{1F600}${"€".repeat(400)} ${index}` }),
		);
		const lowest = floor(wide);
		for (const fraction of [0.3, 0.5, 0.7, 0.9]) {
			const budget = Math.max(lowest, Math.floor(bytes(wide) * fraction));
			expect(bytes(new SightingBudget(budget).fit(wide))).toBeLessThanOrEqual(budget);
		}
	});

	it("keeps under every budget from its floor up", () => {
		const varied = Array.from({ length: 100 }, (_, index) =>
			notice(index, { what: `Changes it. ${"q".repeat(100 + index * 37)}` }),
		);
		const lowest = floor(varied);
		for (const budget of [lowest, lowest + 1, lowest + 500, Math.floor((lowest + bytes(varied)) / 2)]) {
			expect(bytes(new SightingBudget(budget).fit(varied))).toBeLessThanOrEqual(budget);
		}
	});

	it("counts in its note the files of the abridged findings, not the findings", () => {
		const paired = Array.from({ length: 40 }, (_, index) => {
			const one = notice(Math.floor(index / 2));
			return Finding.create({
				rule: one.ruleId,
				message: `${one.message.text} (${index})`,
				file: one.properties.path,
				startLine: 1 + (index % 2),
				discriminator: `d${index}`,
				cause: "introduced",
				trigger: one.properties.trigger,
				severity: "P1",
				explanation: one.properties.explanation,
				source: { check: "guardrails" },
				guardrail: { notice: "analyser" },
			});
		});
		const fitted = new SightingBudget(Math.floor(bytes(paired) / 2)).fit(paired);
		const abridged = fitted.filter((f, index) => f !== paired[index]);
		const files = new Set(abridged.map((f) => f.properties.path)).size;
		expect(files).toBeLessThan(abridged.length);
		expect(new Set(abridged.map((f) => f.properties.explanation.whyHere))).toEqual(new Set([note(files)]));
	});

	it("blocks a trimmed set as the untrimmed one, with the only blocker abridged", () => {
		// One P0 notice among P3s, the one whose ID sorts last, so it is abridged first.
		const probe = Array.from({ length: 61 }, (_, index) => notice(index, { severity: "P3" }));
		const lastIndex = probe.indexOf(byId(probe).at(-1)!);
		const blocker = notice(lastIndex, { severity: "P0" });
		expect(blocker.id).toBe(probe[lastIndex]!.id);
		const mixed = [...probe.filter((_, index) => index !== lastIndex), blocker];
		const fitted = new SightingBudget(bytes(mixed) - 10).fit(mixed);
		expect(fitted.find((f) => f.id === blocker.id)!.properties.explanation.what).toBe(blocker.message.text);
		const verdict = (each: readonly Finding[]) =>
			new Adjudication({ findings: each, manifest: [], checks: [], config: defaultConfig }).adjudicate();
		const before = verdict(mixed);
		const after = verdict(fitted);
		expect(before.blocking).toBe(true);
		expect(after.blocking).toBe(true);
		expect(after.status).toBe(before.status);
		expect(after.findings.block.map((f) => f.properties.id)).toEqual(
			before.findings.block.map((f) => f.properties.id),
		);
		expect(after.findings.acknowledge.map((f) => f.properties.id)).toEqual(
			before.findings.acknowledge.map((f) => f.properties.id),
		);
	});
});

describe("an abridged finding", () => {
	it("keeps its ID, fingerprints, trigger and locations", () => {
		const one = notice(3);
		const short = one.abridged("note");
		const { explanation: _a, ...before } = one.toJSON().properties;
		const { explanation: _b, ...after } = short.toJSON().properties;
		expect(after).toEqual(before);
		expect(short.toJSON().partialFingerprints).toEqual(one.toJSON().partialFingerprints);
		expect(short.toJSON().locations).toEqual(one.toJSON().locations);
	});

	it("keeps as What the shorter of its What and its headline, in UTF-8 bytes, and the headline on a tie", () => {
		const headline = `Review ${"€".repeat(10)}`;
		const what = (text: string) =>
			notice(0, { message: headline, what: text }).abridged("n").properties.explanation.what;
		const width = Buffer.byteLength(headline);
		expect(what("x".repeat(width - 1))).toBe("x".repeat(width - 1));
		expect(what("x".repeat(width))).toBe(headline);
		expect(what("x".repeat(width + 1))).toBe(headline);
		// Fewer characters than the headline, more bytes.
		expect(what("€".repeat(13))).toBe(headline);
	});
});
