import type { CheckRecord } from "@melian-agent/core";
import { DecisionFiles } from "@melian-agent/decisions";
import { contextOverflowed } from "@melian-agent/pipeline";

/** The warning a review gives when the decision index its design lens or verifier read is long. It never changes the verdict. */
export class DecisionIndexWarning {
	readonly text: string;

	private constructor(text: string) {
		this.text = text;
	}

	/**
	 * Reads the index at `base` when one of `checks` shows the design lens or the verifier may have read it; the
	 * verifier reads it for any design rule, which any lens can report. A review that read no index never loads it, so
	 * an index that cannot be read gives no warning here rather than a refusal.
	 */
	static async read(
		repoRoot: string,
		base: string,
		checks: readonly CheckRecord[],
	): Promise<DecisionIndexWarning | undefined> {
		const readers = checks.filter((check) => check.name === "lens.design" || check.name === "verifier");
		if (!readers.some((check) => check.status !== "skipped")) return undefined;
		const warning = await DecisionFiles.load(repoRoot, base).then(
			(index) => index.warning(),
			() => undefined,
		);
		if (warning === undefined) return undefined;
		const overflowed = readers.filter(
			(check) => check.status === "failed" && contextOverflowed(check.error ?? check.reason ?? ""),
		);
		if (overflowed.length === 0) return new DecisionIndexWarning(warning);
		const names = overflowed.map((check) => `\`${check.name}\``).join(" and ");
		return new DecisionIndexWarning(
			`${warning} ${names} failed on a request too long for its model, which the decision index's size may explain.`,
		);
	}
}
