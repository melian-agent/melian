import type { CheckRecord } from "./adjudication.ts";
import { checksOfTier } from "./checks.ts";
import type { MelianConfig } from "./config.ts";
import { mutationSkipHasLeave } from "./mutation.ts";
import type { LevelBand } from "./triage.ts";

/** The lenses a review knows for its change: every lens it loaded, and those it selected, which the caller derives. */
export interface TierLenses {
	/** The name of every lens the review loaded, selected or not. */
	readonly loaded: readonly string[];
	/**
	 * Each lens the review selected for the change, in selection order: its name, the changed paths it covers, and the
	 * band of levels the policy of those paths sets. Two folder variants of one name are two entries.
	 */
	readonly selected: readonly {
		readonly name: string;
		readonly covers: readonly string[];
		readonly band: Pick<LevelBand, "floor">;
	}[];
}

/** What a round recorded that decides a skip: its check and lens records, and triage's decision when it made one. */
export interface RoundFacts {
	/** Every record the round holds for a check, including the lens step's. */
	readonly records: readonly Pick<CheckRecord, "name" | "status" | "cause">[];
	/** Triage's answer per lens and whether its input was cut; absent when triage made no decision. */
	readonly triage?: {
		readonly answers: readonly { readonly question: string; readonly chosen: string }[];
		readonly inputCut: boolean;
	};
}

/** How a round's account differs from what its tier and its own records give. */
export type TierAccountRefusal = "otherChecks" | "missingRecord" | "otherSkips";

/** The checks an account names and the skips it allows, as a review builds it or an account record holds it. */
export interface AccountClaim {
	readonly checks: readonly string[];
	readonly allowSkip: readonly string[];
}

// The review adds the verifier's check to the tier's when the verifier ran, so an account may name it beside them.
const verifier = "verifier";

/**
 * How a review accounts for the checks its tier names: the record it makes for each one no record holds, and the
 * skips that still let the review pass. A skip passes when `checks.allowSkip` names it; when it is a lens of the tier
 * that no selected lens covers; when it is a `decisions.*` question and no decision provider is configured; when it is
 * `static.mutation`, skipped because the change has no production lines; or when triage chose to skip a selected lens
 * whose band's floor is `skip`, from input that was not cut. A lens configuration disables is skipped without leave.
 * Each fact comes from the round's own records or from the caller's selection, so a missing one never allows a skip.
 */
export class TierAccount {
	/** The checks the tier names, in order. */
	readonly checks: readonly string[];
	readonly #config: Pick<MelianConfig, "checks" | "decisions" | "lenses">;
	readonly #lenses: TierLenses;

	private constructor(checks: readonly string[], config: MelianConfig, lenses: TierLenses) {
		this.checks = checks;
		this.#config = config;
		this.#lenses = lenses;
	}

	/** The account of `tier` under `config`, the base's parsed configuration, for a review that knows `lenses`. */
	static of(config: MelianConfig, tier: string, lenses: TierLenses): TierAccount {
		return new TierAccount(checksOfTier(config, tier), config, lenses);
	}

	/**
	 * A record for each lens and decision question of the tier that `records` holds none for. `triagedBy` names the
	 * decider that answered triage, which a skipped question's reason mentions. A selected lens with no record gets
	 * none, so the review reads it as never started.
	 */
	filled(records: readonly Pick<CheckRecord, "name">[], triagedBy?: string): CheckRecord[] {
		const recorded = new Set(records.map((check) => check.name));
		const { provider } = this.#config.decisions;
		return this.checks.flatMap((name): CheckRecord[] => {
			if (recorded.has(name)) return [];
			if (name.startsWith("lens.")) {
				const lens = name.slice("lens.".length);
				if (!this.#lenses.loaded.includes(lens))
					return [{ name, status: "failed", reason: `no lens is named ${lens}` }];
				if (this.#disabled(lens)) return [{ name, status: "skipped", reason: `lenses.${lens}.enabled is false` }];
				return this.#covered(lens) ? [] : [{ name, status: "skipped", reason: "no paths" }];
			}
			if (!name.startsWith("decisions.")) return [];
			if (provider === undefined) {
				const triaged = triagedBy === undefined ? "" : `; triage ran on ${triagedBy}`;
				return [{ name, status: "skipped", reason: `no decision provider is configured${triaged}` }];
			}
			// A configured provider asks for the questions, and Melian cannot ask them yet, so the review fails closed with
			// the reason rather than with no record.
			const reason = `decisions.provider is ${provider}, and Melian has no adapter for a decision provider yet`;
			return [{ name, status: "skipped", reason }];
		});
	}

	/**
	 * The checks whose skip lets the review pass, given what the round recorded: those `checks.allowSkip` names, then each
	 * lens triage skipped, then a mutation check with leave, then the tier's lenses and questions that may skip, in tier
	 * order.
	 */
	allowSkip(facts: RoundFacts): string[] {
		const { triage } = facts;
		const triaged =
			triage === undefined || triage.inputCut
				? []
				: this.#lenses.selected
						.filter(
							({ name, band }) =>
								band.floor === "skip" &&
								triage.answers.find((answer) => answer.question === name)?.chosen === "skip",
						)
						.map(({ name }) => `lens.${name}`);
		// Mutation testing is advisory, so a change it has nothing to mutate passes with the reason recorded. Any other skip
		// of it still leaves the review not reviewed.
		const mutation = facts.records
			.filter((check) => check.name === "static.mutation" && mutationSkipHasLeave(check.cause))
			.map((check) => check.name);
		const tier = this.checks.filter((name) => {
			if (name.startsWith("decisions.")) return this.#config.decisions.provider === undefined;
			if (!name.startsWith("lens.")) return false;
			const lens = name.slice("lens.".length);
			return this.#lenses.loaded.includes(lens) && !this.#disabled(lens) && !this.#covered(lens);
		});
		return [...this.#config.checks.allowSkip, ...triaged, ...mutation, ...tier];
	}

	/**
	 * `undefined` when `account` names the tier's checks, with the verifier's beside them at most, `facts` holds a record
	 * for each, and it allows exactly the skips {@link TierAccount.allowSkip} gives; otherwise the first way it differs.
	 */
	refusal(account: AccountClaim, facts: RoundFacts): TierAccountRefusal | undefined {
		const named = account.checks.filter((name) => name !== verifier);
		if (account.checks.length - named.length > 1 || !sameSet(named, this.checks)) return "otherChecks";
		const recorded = new Set(facts.records.map((check) => check.name));
		if (account.checks.some((name) => !recorded.has(name))) return "missingRecord";
		if (!sameSet([...new Set(account.allowSkip)], [...new Set(this.allowSkip(facts))])) return "otherSkips";
		return undefined;
	}

	#disabled(lens: string): boolean {
		const settings = Object.hasOwn(this.#config.lenses, lens) ? this.#config.lenses[lens] : undefined;
		return settings?.enabled === false;
	}

	#covered(lens: string): boolean {
		return this.#lenses.selected.some(({ name, covers }) => name === lens && covers.length > 0);
	}
}

// Whether `values`, with none twice, are the members of `members`, which holds none twice.
function sameSet(values: readonly string[], members: readonly string[]): boolean {
	const set = new Set(members);
	return (
		values.length === set.size && new Set(values).size === values.length && values.every((value) => set.has(value))
	);
}
