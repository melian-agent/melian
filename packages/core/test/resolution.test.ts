import { type FileResolution, type ResolutionClaim, ResolutionWalk } from "@melian-agent/core";
import { describe, expect, it } from "vitest";

const layer = (file: string, resolution: FileResolution) => ({ file, resolution });
const claim = (fields: Partial<ResolutionClaim> = {}): ResolutionClaim => ({
	check: "lens.cleanup",
	rule: "reuse",
	severity: "P2",
	...fields,
});

describe("ResolutionWalk.decide", () => {
	it("takes the built-in table when no file and no lens speaks", () => {
		expect(new ResolutionWalk([]).decide(claim({ severity: "P1" }))).toEqual({
			resolution: "block",
			requirement: { entry: "built-in", value: "block" },
		});
	});

	it("lets a rule entry beat its check's entry within one file", () => {
		const walk = new ResolutionWalk([
			layer("melian.yaml", {
				P2: "block",
				checks: { "lens.cleanup": { P2: "acknowledge", rules: { reuse: { P2: "advisory" } } } },
			}),
		]);
		expect(walk.decide(claim())).toEqual({
			resolution: "advisory",
			file: "melian.yaml",
			requirement: { entry: "rule", key: "resolution.checks.lens.cleanup.rules.reuse.P2", value: "advisory" },
		});
		expect(walk.decide(claim({ rule: "altitude" })).requirement).toEqual({
			entry: "check",
			key: "resolution.checks.lens.cleanup.P2",
			value: "acknowledge",
		});
	});

	it("lets a check entry beat the file's table within one file", () => {
		const walk = new ResolutionWalk([
			layer("melian.yaml", { P2: "block", checks: { "lens.cleanup": { P2: "advisory" } } }),
		]);
		expect(walk.decide(claim()).resolution).toBe("advisory");
		expect(walk.decide(claim({ check: "lens.correctness" }))).toEqual({
			resolution: "block",
			file: "melian.yaml",
			requirement: { entry: "table", key: "resolution.P2", value: "block" },
		});
	});

	it("caps a mapping with a ceiling in the same file, and never raises one", () => {
		const walk = new ResolutionWalk([
			layer("melian.yaml", { P1: "block", P3: "advisory", checks: { "lens.cleanup": { ceiling: "acknowledge" } } }),
		]);
		expect(walk.decide(claim({ severity: "P1" }))).toEqual({
			resolution: "acknowledge",
			file: "melian.yaml",
			requirement: { entry: "table", key: "resolution.P1", value: "block" },
			ceiling: { entry: "check", key: "resolution.checks.lens.cleanup.ceiling", value: "acknowledge" },
		});
		expect(walk.decide(claim({ severity: "P3" })).resolution).toBe("advisory");
	});

	it("takes a rule's ceiling before its check's", () => {
		const walk = new ResolutionWalk([
			layer("melian.yaml", {
				checks: { "lens.cleanup": { ceiling: "silent", rules: { reuse: { ceiling: "advisory" } } } },
			}),
		]);
		expect(walk.decide(claim({ severity: "P0" })).resolution).toBe("advisory");
		expect(walk.decide(claim({ severity: "P0", rule: "altitude" })).resolution).toBe("silent");
	});

	it("stops at the nearest table, so a root rule entry never applies", () => {
		const walk = new ResolutionWalk([
			layer("services/payments/melian.yaml", { P1: "block" }),
			layer("melian.yaml", {
				checks: { "lens.trust-boundary": { rules: { "terminal-escape": { P1: "acknowledge" } } } },
			}),
		]);
		const finding = claim({ check: "lens.trust-boundary", rule: "terminal-escape", severity: "P1" });
		expect(walk.decide(finding)).toEqual({
			resolution: "block",
			file: "services/payments/melian.yaml",
			requirement: { entry: "table", key: "resolution.P1", value: "block" },
		});
		expect(new ResolutionWalk(walk.layers.slice(1)).decide(finding).resolution).toBe("acknowledge");
	});

	it("drops a farther file's ceiling once a nearer file speaks", () => {
		const walk = new ResolutionWalk([
			layer("services/payments/melian.yaml", { P1: "block" }),
			layer("melian.yaml", { P2: "acknowledge", checks: { "lens.cleanup": { ceiling: "advisory" } } }),
		]);
		expect(walk.decide(claim({ severity: "P1" })).resolution).toBe("block");
		// The nearer file writes no P2 and nothing for the check, so the root decides, mapping and ceiling both.
		expect(walk.decide(claim({ severity: "P2" }))).toMatchObject({ resolution: "advisory", file: "melian.yaml" });
	});

	it("does not let a rule entry that maps only P1 speak for a P2 finding of that rule", () => {
		const walk = new ResolutionWalk([
			layer("a/melian.yaml", { checks: { "lens.cleanup": { rules: { reuse: { P1: "silent" } } } } }),
			layer("melian.yaml", { P2: "block" }),
		]);
		expect(walk.decide(claim({ severity: "P2" }))).toMatchObject({ resolution: "block", file: "melian.yaml" });
		expect(walk.decide(claim({ severity: "P1" }))).toMatchObject({ resolution: "silent", file: "a/melian.yaml" });
	});

	it("takes the built-in requirement in a file that speaks only through a ceiling, never a farther table's", () => {
		const walk = new ResolutionWalk([
			layer("a/melian.yaml", { checks: { "lens.cleanup": { ceiling: "block" } } }),
			layer("melian.yaml", { P2: "silent", P3: "block" }),
		]);
		expect(walk.decide(claim({ severity: "P2" }))).toEqual({
			resolution: "acknowledge",
			file: "a/melian.yaml",
			requirement: { entry: "built-in", value: "acknowledge" },
			ceiling: { entry: "check", key: "resolution.checks.lens.cleanup.ceiling", value: "block" },
		});
		expect(walk.decide(claim({ severity: "P3" })).resolution).toBe("advisory");
		expect(walk.decide(claim({ check: "lens.tests", severity: "P3" })).resolution).toBe("block");
	});

	it("applies a lens's declared default only when no file speaks", () => {
		const defaults = { cleanup: { ceiling: "advisory", P3: "silent" } } as const;
		expect(new ResolutionWalk([], defaults).decide(claim({ severity: "P1" }))).toEqual({
			resolution: "advisory",
			lens: "cleanup",
			requirement: { entry: "built-in", value: "block" },
			ceiling: { entry: "lens-default", key: "resolution.ceiling", value: "advisory" },
		});
		expect(new ResolutionWalk([], defaults).decide(claim({ severity: "P3" }))).toEqual({
			resolution: "silent",
			lens: "cleanup",
			requirement: { entry: "lens-default", key: "resolution.P3", value: "silent" },
			ceiling: { entry: "lens-default", key: "resolution.ceiling", value: "advisory" },
		});
		expect(new ResolutionWalk([], defaults).decide(claim({ check: "lens.tests", severity: "P1" })).resolution).toBe(
			"block",
		);
		expect(new ResolutionWalk([], defaults).decide(claim({ check: "lint.cleanup", severity: "P1" })).resolution).toBe(
			"block",
		);
		const spoken = new ResolutionWalk([layer("melian.yaml", { P1: "acknowledge" })], defaults);
		expect(spoken.decide(claim({ severity: "P1" }))).toMatchObject({
			resolution: "acknowledge",
			file: "melian.yaml",
		});
		expect(spoken.decide(claim({ severity: "P0" }))).toMatchObject({ resolution: "advisory", lens: "cleanup" });
	});

	it("names no lens when the lens's default says nothing about the severity", () => {
		const walk = new ResolutionWalk([], { cleanup: { P1: "advisory" } });
		expect(walk.decide(claim({ severity: "P2" }))).toEqual({
			resolution: "acknowledge",
			requirement: { entry: "built-in", value: "acknowledge" },
		});
		expect(walk.decide(claim({ severity: "P1" }))).toEqual({
			resolution: "advisory",
			lens: "cleanup",
			requirement: { entry: "lens-default", key: "resolution.P1", value: "advisory" },
		});
	});

	it("looks a lens named like an Object method up among the declared defaults only", () => {
		expect(new ResolutionWalk([]).decide(claim({ check: "lens.constructor" })).resolution).toBe("acknowledge");
		const walk = new ResolutionWalk([layer("melian.yaml", { checks: { "lens.cleanup": { ceiling: "silent" } } })]);
		expect(walk.decide(claim({ check: "constructor" })).resolution).toBe("acknowledge");
		expect(walk.decide(claim({ rule: "constructor" })).ceiling?.key).toBe("resolution.checks.lens.cleanup.ceiling");
	});

	it("keys a guardrail rule under its own name, then its whole guardrail, then the check", () => {
		const focused = claim({
			check: "guardrails",
			rule: "guardrail/forbidden-patterns/focused-test",
			group: "guardrail/forbidden-patterns",
		});
		const rules = {
			"guardrail/forbidden-patterns/focused-test": { P2: "block" },
			"guardrail/forbidden-patterns": { P2: "advisory", ceiling: "acknowledge" },
		} as const;
		const walk = new ResolutionWalk([layer("melian.yaml", { checks: { guardrails: { P2: "silent", rules } } })]);
		expect(walk.decide(focused)).toEqual({
			resolution: "acknowledge",
			file: "melian.yaml",
			requirement: {
				entry: "rule",
				key: "resolution.checks.guardrails.rules.guardrail/forbidden-patterns/focused-test.P2",
				value: "block",
			},
			ceiling: {
				entry: "check",
				key: "resolution.checks.guardrails.rules.guardrail/forbidden-patterns.ceiling",
				value: "acknowledge",
			},
		});
		expect(walk.decide({ ...focused, rule: "guardrail/forbidden-patterns/dynamic-import" }).requirement).toEqual({
			entry: "check",
			key: "resolution.checks.guardrails.rules.guardrail/forbidden-patterns.P2",
			value: "advisory",
		});
		expect(walk.decide(claim({ check: "guardrails", group: "guardrail/forbidden-paths" })).requirement).toEqual({
			entry: "check",
			key: "resolution.checks.guardrails.P2",
			value: "silent",
		});
	});

	it("lets a whole-guardrail entry in a nearer file speak for a named rule's finding", () => {
		const walk = new ResolutionWalk([
			layer("a/melian.yaml", {
				checks: { guardrails: { rules: { "guardrail/forbidden-patterns": { ceiling: "advisory" } } } },
			}),
			layer("melian.yaml", {
				checks: { guardrails: { rules: { "guardrail/forbidden-patterns/focused-test": { P2: "block" } } } },
			}),
		]);
		const focused = claim({
			check: "guardrails",
			rule: "guardrail/forbidden-patterns/focused-test",
			group: "guardrail/forbidden-patterns",
		});
		expect(walk.decide(focused)).toMatchObject({ resolution: "advisory", file: "a/melian.yaml" });
	});

	it("reads only tables for a claim no entry may move", () => {
		const walk = new ResolutionWalk([
			layer("a/melian.yaml", { checks: { guardrails: { ceiling: "advisory", P2: "silent" } } }),
			layer("melian.yaml", { P2: "block" }),
		]);
		expect(walk.decide({ check: "guardrails", severity: "P2", tableOnly: true })).toEqual({
			resolution: "block",
			file: "melian.yaml",
			requirement: { entry: "table", key: "resolution.P2", value: "block" },
		});
	});

	it("stands one configuration for every path in for a single file that names none", () => {
		const walk = ResolutionWalk.over({
			resolution: { P2: "block", checks: { "lens.cleanup": { ceiling: "advisory" } } },
		});
		expect(walk.decide(claim())).toEqual({
			resolution: "advisory",
			requirement: { entry: "table", key: "resolution.P2", value: "block" },
			ceiling: { entry: "check", key: "resolution.checks.lens.cleanup.ceiling", value: "advisory" },
		});
		const layered = ResolutionWalk.over({
			resolution: { P2: "block" },
			layers: [layer("melian.yaml", { P2: "silent" })],
			lensDefaults: { cleanup: { ceiling: "silent" } },
		});
		expect(layered.decide(claim())).toMatchObject({ resolution: "silent", file: "melian.yaml" });
		expect(layered.decide(claim({ severity: "P0" }))).toMatchObject({ resolution: "silent", lens: "cleanup" });
	});
});

describe("ResolutionWalk.overrides", () => {
	it("lists nothing for a lone file and no lens default", () => {
		expect(new ResolutionWalk([layer("melian.yaml", { P1: "acknowledge" })]).overrides()).toEqual([]);
	});

	it("lists the farther rule entry and ceiling a nearer table overrides, for the severity it writes", () => {
		const walk = new ResolutionWalk([
			layer("services/payments/melian.yaml", { P1: "block" }),
			layer("melian.yaml", {
				P2: "acknowledge",
				checks: {
					"lens.cleanup": { ceiling: "advisory" },
					"lens.trust-boundary": { rules: { "terminal-escape": { P1: "acknowledge" } } },
				},
			}),
		]);
		expect(walk.overrides()).toEqual([
			"services/payments/melian.yaml: resolution.P1 overrides melian.yaml's resolution.checks.lens.cleanup.ceiling for P1 lens.cleanup findings",
			"services/payments/melian.yaml: resolution.P1 overrides melian.yaml's resolution.checks.lens.trust-boundary.rules.terminal-escape for P1 lens.trust-boundary terminal-escape findings",
		]);
	});

	it("lists a lens's declared ceiling a table overrides, and nothing once the file restates it", () => {
		const defaults = { cleanup: { ceiling: "advisory" } } as const;
		expect(new ResolutionWalk([layer("melian.yaml", { P2: "acknowledge" })], defaults).overrides()).toEqual([
			"melian.yaml: resolution.P2 overrides lens cleanup's declared ceiling for P2 lens.cleanup findings",
		]);
		const restated = layer("melian.yaml", { P2: "acknowledge", checks: { "lens.cleanup": { ceiling: "advisory" } } });
		expect(new ResolutionWalk([restated], defaults).overrides()).toEqual([]);
		const moved = layer("melian.yaml", { P2: "acknowledge", checks: { "lens.cleanup": { ceiling: "acknowledge" } } });
		expect(new ResolutionWalk([moved], defaults).overrides()).toEqual([
			"melian.yaml: resolution.checks.lens.cleanup.ceiling overrides lens cleanup's declared ceiling for P0, P1, P3, nit lens.cleanup findings",
			"melian.yaml: resolution.P2 overrides lens cleanup's declared ceiling for P2 lens.cleanup findings",
		]);
	});

	it("lists a lens's declared mapping a nearer mapping overrides", () => {
		const walk = new ResolutionWalk([layer("melian.yaml", { P3: "advisory" })], { cleanup: { P3: "silent" } });
		expect(walk.overrides()).toEqual([
			"melian.yaml: resolution.P3 overrides lens cleanup's declared mapping for P3 lens.cleanup findings",
		]);
	});

	it("lists the farther table a ceiling-only file drops, even where the built-in value is the same", () => {
		const walk = new ResolutionWalk([
			layer("a/melian.yaml", { checks: { "lens.cleanup": { ceiling: "block" } } }),
			layer("melian.yaml", { P2: "acknowledge" }),
		]);
		expect(walk.overrides()).toEqual([
			"a/melian.yaml: resolution.checks.lens.cleanup.ceiling overrides melian.yaml's table for P2 lens.cleanup findings",
		]);
	});

	it("says nothing of a farther value the nearer file restates in an entry of its own", () => {
		const walk = new ResolutionWalk([
			layer("a/melian.yaml", { P1: "block", P2: "advisory" }),
			layer("melian.yaml", { P1: "block", P2: "acknowledge" }),
		]);
		expect(walk.overrides()).toEqual(["a/melian.yaml: resolution.P2 overrides melian.yaml's table for P2 findings"]);
	});

	it("folds a named check's line into the line about every check, and a rule's into its check's", () => {
		const walk = new ResolutionWalk([
			layer("a/melian.yaml", { P2: "block", checks: { "lens.cleanup": { ceiling: "silent" } } }),
			layer("melian.yaml", {
				P2: "acknowledge",
				checks: {
					"lens.tests": { P3: "block" },
					"lens.cleanup": { P1: "advisory", rules: { reuse: { P0: "block" } } },
				},
			}),
		]);
		expect(walk.overrides()).toEqual([
			"a/melian.yaml: resolution.P2 overrides melian.yaml's table for P2 findings",
			"a/melian.yaml: resolution.checks.lens.cleanup.ceiling overrides melian.yaml's resolution.checks.lens.cleanup for P1 lens.cleanup findings",
			"a/melian.yaml: resolution.checks.lens.cleanup.ceiling overrides melian.yaml's resolution.checks.lens.cleanup.rules.reuse for P0 lens.cleanup reuse findings",
		]);
	});

	it("keeps a named check's line when it speaks through another entry, or overrides another", () => {
		const walk = new ResolutionWalk([
			layer("a/melian.yaml", { P2: "block", checks: { "lens.cleanup": { P2: "silent" } } }),
			layer("melian.yaml", { P2: "acknowledge", checks: { "lens.tests": { P2: "advisory" } } }),
		]);
		expect(walk.overrides()).toEqual([
			"a/melian.yaml: resolution.P2 overrides melian.yaml's table for P2 findings",
			"a/melian.yaml: resolution.checks.lens.cleanup.P2 overrides melian.yaml's table for P2 lens.cleanup findings",
			"a/melian.yaml: resolution.P2 overrides melian.yaml's resolution.checks.lens.tests for P2 lens.tests findings",
		]);
	});

	it("probes a static rule under its own name alone, never as a rule of a shorter one", () => {
		const walk = new ResolutionWalk([
			layer("a/melian.yaml", { checks: { "static.biome": { rules: { "biome/a/b": { P2: "advisory" } } } } }),
			layer("melian.yaml", { checks: { "static.biome": { rules: { "biome/a": { P2: "block" } } } } }),
		]);
		expect(walk.overrides()).toEqual([]);
	});

	it("lists each file against what is farther from it, a guardrail's whole entry over a named rule's", () => {
		const walk = new ResolutionWalk([
			layer("a/b/melian.yaml", {
				checks: { guardrails: { rules: { "guardrail/forbidden-patterns": { ceiling: "advisory" } } } },
			}),
			layer("a/melian.yaml", { P3: "silent" }),
			layer("melian.yaml", {
				P3: "advisory",
				checks: { guardrails: { rules: { "guardrail/forbidden-patterns/focused-test": { P2: "block" } } } },
			}),
		]);
		expect(walk.overrides()).toEqual([
			"a/b/melian.yaml: resolution.checks.guardrails.rules.guardrail/forbidden-patterns.ceiling overrides a/melian.yaml's table for P3 guardrails guardrail/forbidden-patterns findings",
			"a/b/melian.yaml: resolution.checks.guardrails.rules.guardrail/forbidden-patterns.ceiling overrides melian.yaml's resolution.checks.guardrails.rules.guardrail/forbidden-patterns/focused-test for P2 guardrails guardrail/forbidden-patterns/focused-test findings",
			"a/melian.yaml: resolution.P3 overrides melian.yaml's table for P3 findings",
		]);
	});
});
