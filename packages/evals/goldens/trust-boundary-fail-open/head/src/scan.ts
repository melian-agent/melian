import type { Rule } from "./rules.ts";

export interface Hit {
	readonly rule: string;
	readonly line: number;
	readonly message: string;
}

// A regular expression can take time that grows with the line, so lines past this length are not matched.
const maxLineLength = 10_000;

/** Every line a pull request adds that matches a rule, numbered from 1. */
export function scan(added: readonly string[], rules: readonly Rule[]): Hit[] {
	const hits: Hit[] = [];
	added.forEach((text, index) => {
		if (text.length > maxLineLength) return;
		for (const rule of rules) if (rule.pattern.test(text)) hits.push({ rule: rule.name, line: index + 1, message: rule.message });
	});
	return hits;
}
