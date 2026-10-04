import type { Rule } from "./rules.ts";

export interface Hit {
	readonly rule: string;
	readonly line: number;
	readonly message: string;
}

/** Every line a pull request adds that matches a rule, numbered from 1. */
export function scan(added: readonly string[], rules: readonly Rule[]): Hit[] {
	const hits: Hit[] = [];
	added.forEach((text, index) => {
		for (const rule of rules) if (rule.pattern.test(text)) hits.push({ rule: rule.name, line: index + 1, message: rule.message });
	});
	return hits;
}
