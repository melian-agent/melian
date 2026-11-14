import type { CheckRecord } from "@melian-agent/core";
import { contextOverflowed } from "@melian-agent/pipeline";

/** The warning a review gives when the decision index it gave its design lens or verifier is long. It never changes the verdict. */
export class DecisionIndexWarning {
	readonly text: string;

	private constructor(text: string) {
		this.text = text;
	}

	/** Adds to the pipeline's `warning`, if any, which of `checks` failed on a request too long for its model. */
	static from(warning: string | undefined, checks: readonly CheckRecord[]): DecisionIndexWarning | undefined {
		if (warning === undefined) return undefined;
		const overflowed = checks.filter(
			(check) =>
				(check.name === "lens.design" || check.name === "verifier") &&
				check.status === "failed" &&
				contextOverflowed(check.error ?? check.reason ?? ""),
		);
		if (overflowed.length === 0) return new DecisionIndexWarning(warning);
		const names = overflowed.map((check) => `\`${check.name}\``).join(" and ");
		return new DecisionIndexWarning(
			`${warning} ${names} failed on a request too long for its model, which the decision index's size may explain.`,
		);
	}
}
