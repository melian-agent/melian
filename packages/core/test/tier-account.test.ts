import { beforeEach, describe, expect, it } from "vitest";
import {
	type CheckRecord,
	defaultConfig,
	LevelBand,
	type MelianConfig,
	type RoundFacts,
	TierAccount,
	type TierLenses,
} from "../src/index.ts";

const tiers = {
	...defaultConfig.tiers,
	full: ["guardrails", "static", "static.mutation", "decisions.fast", "lens.correctness", "lens.contracts"],
};
const config: MelianConfig = { ...defaultConfig, tiers };
const checks = [
	"guardrails",
	"static.biome",
	"static.tsc",
	"static.mutation",
	"decisions.fast",
	"lens.correctness",
	"lens.contracts",
];
const skipFloor = LevelBand.of({ floor: "skip" });
const quickFloor = LevelBand.of(undefined);

// Correctness covers the change under a floor of skip; contracts is loaded and covers nothing.
const lenses: TierLenses = {
	loaded: ["correctness", "contracts"],
	selected: [{ name: "correctness", covers: ["src/user.ts"], band: skipFloor }],
};

const ran = (name: string): CheckRecord => ({ name, status: "ran" });
const hostRecords: CheckRecord[] = [ran("guardrails"), ran("static.biome"), ran("static.tsc"), ran("static.mutation")];
const records = [...hostRecords, ran("lens.correctness")];
const skippedMutation: CheckRecord = {
	name: "static.mutation",
	status: "skipped",
	reason: "the change adds or edits no production TypeScript lines",
	cause: "noProductionLines",
};
const chose = (chosen: string, inputCut = false): NonNullable<RoundFacts["triage"]> => ({
	answers: [{ question: "correctness", chosen }],
	inputCut,
});

describe("TierAccount", () => {
	it("names the tier's checks in order", () => {
		expect(TierAccount.of(config, "full", lenses).checks).toEqual(checks);
	});

	describe("filled", () => {
		it("records each unrecorded lens and question of the tier, and nothing for a recorded one", () => {
			expect(TierAccount.of(config, "full", lenses).filled(records)).toEqual([
				{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
				{ name: "lens.contracts", status: "skipped", reason: "no paths" },
			]);
		});

		it("names the decider that answered triage in a skipped question's reason", () => {
			expect(TierAccount.of(config, "full", lenses).filled(records, "recorded")[0]).toEqual({
				name: "decisions.fast",
				status: "skipped",
				reason: "no decision provider is configured; triage ran on recorded",
			});
		});

		it("records a question skipped without leave when a provider is configured", () => {
			const provided = { ...config, decisions: { provider: "acme", thresholds: {} } };
			expect(TierAccount.of(provided, "full", lenses).filled(records)[0]).toEqual({
				name: "decisions.fast",
				status: "skipped",
				reason: "decisions.provider is acme, and Melian has no adapter for a decision provider yet",
			});
		});

		it("records a lens no file defines as failed", () => {
			const unknown = { loaded: ["correctness"], selected: lenses.selected };
			expect(TierAccount.of(config, "full", unknown).filled(records)[1]).toEqual({
				name: "lens.contracts",
				status: "failed",
				reason: "no lens is named contracts",
			});
		});

		it("records a lens configuration disables as skipped for that", () => {
			const disabled = { ...config, lenses: { contracts: { enabled: false } } };
			expect(TierAccount.of(disabled, "full", lenses).filled(records)[1]).toEqual({
				name: "lens.contracts",
				status: "skipped",
				reason: "lenses.contracts.enabled is false",
			});
		});

		it("fills nothing for a selected lens that covers a path and has no record, so it reads as never started", () => {
			const both = {
				loaded: lenses.loaded,
				selected: [...lenses.selected, { name: "contracts", covers: ["src/user.ts"], band: quickFloor }],
			};
			expect(TierAccount.of(config, "full", both).filled(records)).toEqual([
				{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
			]);
		});

		it("fills nothing for a lens or a question that already has a record", () => {
			const held = [...records, ran("decisions.fast"), ran("lens.contracts")];
			expect(TierAccount.of(config, "full", lenses).filled(held)).toEqual([]);
		});

		it("fills nothing for a host check of the tier with no record", () => {
			const missing = records.filter(({ name }) => name !== "static.tsc");
			expect(TierAccount.of(config, "full", lenses).filled(missing)).toEqual([
				{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
				{ name: "lens.contracts", status: "skipped", reason: "no paths" },
			]);
		});

		it("fills a selected lens that covers no path as no paths", () => {
			const empty = {
				loaded: lenses.loaded,
				selected: [...lenses.selected, { name: "contracts", covers: [], band: quickFloor }],
			};
			expect(TierAccount.of(config, "full", empty).filled(records)[1]).toEqual({
				name: "lens.contracts",
				status: "skipped",
				reason: "no paths",
			});
		});
	});

	describe("allowSkip", () => {
		let account: TierAccount;
		beforeEach(() => {
			account = TierAccount.of(config, "full", lenses);
		});

		it("allows the tier's question with no provider and its lens that covers nothing, and no other", () => {
			expect(account.allowSkip({ records })).toEqual(["decisions.fast", "lens.contracts"]);
		});

		it("puts configuration's skips first, then triage's, then mutation's, then the tier's", () => {
			const named = TierAccount.of(
				{ ...config, checks: { allowSkip: ["static.tsc", "elsewhere"] } },
				"full",
				lenses,
			);
			expect(
				named.allowSkip({ records: [...hostRecords.slice(0, 3), skippedMutation], triage: chose("skip") }),
			).toEqual([
				"static.tsc",
				"elsewhere",
				"lens.correctness",
				"static.mutation",
				"decisions.fast",
				"lens.contracts",
			]);
		});

		it("allows a lens triage skipped under a floor of skip from input that was not cut", () => {
			expect(account.allowSkip({ records, triage: chose("skip") })).toEqual([
				"lens.correctness",
				"decisions.fast",
				"lens.contracts",
			]);
		});

		it.each([
			["the input was cut", chose("skip", true), skipFloor],
			["triage chose a level", chose("quick"), skipFloor],
			["the floor is quick", chose("skip"), quickFloor],
			[
				"triage answered another lens",
				{ answers: [{ question: "contracts", chosen: "skip" }], inputCut: false },
				skipFloor,
			],
			["triage made no decision", undefined, skipFloor],
		])("allows no triage skip when %s", (_, triage, band) => {
			const held = TierAccount.of(config, "full", {
				loaded: lenses.loaded,
				selected: [{ name: "correctness", covers: ["src/user.ts"], band }],
			});
			expect(held.allowSkip({ records, ...(triage === undefined ? {} : { triage }) })).toEqual([
				"decisions.fast",
				"lens.contracts",
			]);
		});

		// The review selects no lens configuration disables, but a reader builds its own selection.
		it("allows no triage skip of a lens configuration disables", () => {
			const disabled = TierAccount.of({ ...config, lenses: { correctness: { enabled: false } } }, "full", lenses);
			expect(disabled.allowSkip({ records, triage: chose("skip") })).toEqual(["decisions.fast", "lens.contracts"]);
		});

		it("allows a skip for each variant of a lens triage skipped", () => {
			const variants = TierAccount.of(config, "full", {
				loaded: lenses.loaded,
				selected: [
					{ name: "correctness", covers: ["src/user.ts"], band: skipFloor },
					{ name: "correctness", covers: ["lib/user.ts"], band: quickFloor },
					{ name: "correctness", covers: ["app/user.ts"], band: skipFloor },
				],
			});
			expect(variants.allowSkip({ records, triage: chose("skip") })).toEqual([
				"lens.correctness",
				"lens.correctness",
				"decisions.fast",
				"lens.contracts",
			]);
		});

		it("allows a mutation skip only for a change with no production lines", () => {
			const timedOut: CheckRecord = { ...skippedMutation, cause: "timeout" };
			const { cause: _, ...uncaused } = skippedMutation;
			expect(account.allowSkip({ records: [skippedMutation] })).toEqual([
				"static.mutation",
				"decisions.fast",
				"lens.contracts",
			]);
			expect(account.allowSkip({ records: [timedOut] })).toEqual(["decisions.fast", "lens.contracts"]);
			expect(account.allowSkip({ records: [uncaused] })).toEqual(["decisions.fast", "lens.contracts"]);
			expect(account.allowSkip({ records: [{ ...skippedMutation, name: "static.tsc" }] })).toEqual([
				"decisions.fast",
				"lens.contracts",
			]);
		});

		it("allows no question's skip when a provider is configured", () => {
			const provided = { ...config, decisions: { provider: "acme", thresholds: {} } };
			expect(TierAccount.of(provided, "full", lenses).allowSkip({ records })).toEqual(["lens.contracts"]);
		});

		it("allows no skip of a tier lens no file defines, or one configuration disables", () => {
			expect(
				TierAccount.of(config, "full", { loaded: ["correctness"], selected: lenses.selected }).allowSkip({
					records,
				}),
			).toEqual(["decisions.fast"]);
			const disabled = { ...config, lenses: { contracts: { enabled: false } } };
			expect(TierAccount.of(disabled, "full", lenses).allowSkip({ records })).toEqual(["decisions.fast"]);
		});

		it("allows the skip of a lens whose settings leave it enabled", () => {
			const enabled = { ...config, lenses: { contracts: { enabled: true } } };
			expect(TierAccount.of(enabled, "full", lenses).allowSkip({ records })).toEqual([
				"decisions.fast",
				"lens.contracts",
			]);
		});

		it("allows no skip of a lens the change selected", () => {
			const both = TierAccount.of(config, "full", {
				loaded: lenses.loaded,
				selected: [...lenses.selected, { name: "contracts", covers: ["src/user.ts"], band: quickFloor }],
			});
			expect(both.allowSkip({ records })).toEqual(["decisions.fast"]);
		});

		it("allows no skip of a host check whose name ends in a loaded lens's name", () => {
			const host = TierAccount.of({ ...config, tiers: { ...tiers, full: ["guardrails"] } }, "full", {
				loaded: ["rails"],
				selected: [],
			});
			expect(host.allowSkip({ records: [] })).toEqual([]);
		});

		it("allows no skip of a deterministic check of the tier on its own", () => {
			const host = TierAccount.of(
				{ ...config, tiers: { ...tiers, full: ["guardrails", "static"] } },
				"full",
				lenses,
			);
			expect(host.allowSkip({ records: [] })).toEqual([]);
		});
	});

	describe("refusal", () => {
		let account: TierAccount;
		beforeEach(() => {
			account = TierAccount.of(config, "full", lenses);
		});
		const facts: RoundFacts = {
			records: [
				...records,
				{ name: "decisions.fast", status: "skipped", reason: "no decision provider is configured" },
				{ name: "lens.contracts", status: "skipped", reason: "no paths" },
			],
		};
		const claim = { checks, allowSkip: ["lens.contracts", "decisions.fast"] };

		it("refuses nothing in the account the tier and the round's records give", () => {
			expect(account.refusal(claim, facts)).toBeUndefined();
		});

		it("refuses nothing when the account names the verifier once and the round holds its record", () => {
			const verified = { ...claim, checks: [...checks, "verifier"] };
			expect(account.refusal(verified, { records: [...facts.records, ran("verifier")] })).toBeUndefined();
		});

		it("refuses the verifier named twice", () => {
			const twice = { ...claim, checks: [...checks, "verifier", "verifier"] };
			expect(account.refusal(twice, { records: [...facts.records, ran("verifier")] })).toBe("otherChecks");
		});

		it.each([
			["one check fewer", checks.slice(1)],
			["one check more", [...checks, "static.enola"]],
			["another check in one's place", [...checks.slice(1), "static.enola"]],
			["one check twice in another's place", [...checks.slice(1), checks[1]!]],
			["no checks", []],
		])("refuses an account with %s than the tier names", (_, named) => {
			expect(account.refusal({ ...claim, checks: named }, facts)).toEqual("otherChecks");
		});

		it("refuses an account missing a record for a check of the tier", () => {
			const missing = { records: facts.records.filter(({ name }) => name !== "static.tsc") };
			expect(account.refusal(claim, missing)).toEqual("missingRecord");
		});

		it("refuses an account missing the verifier's record", () => {
			expect(account.refusal({ ...claim, checks: [...checks, "verifier"] }, facts)).toEqual("missingRecord");
		});

		it.each([
			["a skip none of the reasons gives", ["lens.contracts", "decisions.fast", "static.tsc"]],
			["one skip fewer", ["decisions.fast"]],
			["no skips", []],
			["a lens triage never skipped", ["lens.contracts", "decisions.fast", "lens.correctness"]],
		])("refuses an account that allows %s", (_, allowSkip) => {
			expect(account.refusal({ ...claim, allowSkip }, facts)).toEqual("otherSkips");
		});

		it("refuses nothing for an account that names one allowed skip twice", () => {
			const twice = { ...claim, allowSkip: [...claim.allowSkip, "decisions.fast"] };
			expect(account.refusal(twice, facts)).toBeUndefined();
		});

		it("accepts a triage skip the round's own triage record gives", () => {
			const skipped = { ...claim, allowSkip: ["lens.correctness", ...claim.allowSkip] };
			expect(account.refusal(skipped, { ...facts, triage: chose("skip") })).toBeUndefined();
		});

		it.each([
			["the round holds no triage decision", undefined],
			["triage's input was cut", chose("skip", true)],
		])("refuses a triage skip when %s", (_, triage) => {
			const skipped = { ...claim, allowSkip: ["lens.correctness", ...claim.allowSkip] };
			expect(account.refusal(skipped, { ...facts, ...(triage === undefined ? {} : { triage }) })).toEqual(
				"otherSkips",
			);
		});

		it("refuses a mutation skip whose record holds no cause", () => {
			const { cause: _, ...uncaused } = skippedMutation;
			const round = { records: [...facts.records.filter(({ name }) => name !== "static.mutation"), uncaused] };
			const skipped = { ...claim, allowSkip: [...claim.allowSkip, "static.mutation"] };
			expect(account.refusal(skipped, round)).toEqual("otherSkips");
			expect(
				account.refusal(skipped, {
					records: [...facts.records.filter(({ name }) => name !== "static.mutation"), skippedMutation],
				}),
			).toBeUndefined();
		});
	});

	describe("meetsFloor", () => {
		const of = (...selected: TierLenses["selected"]) =>
			TierAccount.of(config, "full", { loaded: ["correctness", "contracts"], selected });
		const careful = LevelBand.of({ floor: "careful" });

		it("holds a lens's level at its floor and refuses one below it", () => {
			const account = of({ name: "correctness", covers: ["src/user.ts"], band: careful });
			expect(account.meetsFloor("correctness", "careful")).toBe(true);
			expect(account.meetsFloor("correctness", "deep")).toBe(true);
			expect(account.meetsFloor("correctness", "quick")).toBe(false);
		});

		it("holds any level under a floor of skip", () => {
			expect(
				of({ name: "correctness", covers: ["src/user.ts"], band: skipFloor }).meetsFloor("correctness", "quick"),
			).toBe(true);
		});

		it("refuses a level below the floor of any one variant of the lens", () => {
			const account = of(
				{ name: "correctness", covers: ["src/user.ts"], band: quickFloor },
				{ name: "correctness", covers: ["lib/user.ts"], band: careful },
			);
			expect(account.meetsFloor("correctness", "quick")).toBe(false);
		});

		it("refuses a run with no level, even of a lens no path selects", () => {
			const account = of({ name: "correctness", covers: ["src/user.ts"], band: skipFloor });
			expect(account.meetsFloor("correctness", undefined)).toBe(false);
			expect(account.meetsFloor("contracts", undefined)).toBe(false);
		});

		it.each([
			["after", [careful, quickFloor]],
			["before", [quickFloor, careful]],
		])(
			"names the highest floor of a lens's variants, listed %s the lower, and none for a lens no path selects",
			(_, bands) => {
				const account = of(
					{ name: "correctness", covers: ["src/user.ts"], band: bands[0]! },
					{ name: "correctness", covers: ["lib/user.ts"], band: bands[1]! },
					{ name: "contracts", covers: ["src/user.ts"], band: skipFloor },
				);
				expect([account.floor("correctness"), account.floor("contracts"), account.floor("security")]).toEqual([
					"careful",
					"skip",
					undefined,
				]);
			},
		);

		it("reads only the named lens's floor", () => {
			const account = of(
				{ name: "correctness", covers: ["src/user.ts"], band: quickFloor },
				{ name: "contracts", covers: ["src/user.ts"], band: careful },
			);
			expect(account.meetsFloor("correctness", "quick")).toBe(true);
			expect(account.meetsFloor("contracts", "quick")).toBe(false);
		});
	});
});
