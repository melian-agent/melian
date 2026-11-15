// The parts of core's render.ts that scripts/round.mjs imports.

/**
 * Which budget ended a lens's conversation, and its limit, with what the lens had used of each when it ended: input and
 * output tokens, and tool calls counted against the budget.
 */
export interface BudgetEnd {
	readonly budget: "tokens" | "tools";
	readonly limit: number;
	readonly tokens: number;
	readonly tools: number;
}

/**
 * Why a check ran on `model` rather than the route the committed `melian.yaml` set: `by` names the preference file,
 * the `--model` flag, or `derived` when the resolver picked a model because none of the route had credentials.
 * `wanted` is the model policy routes the tier to, where it names one. `outside` says policy's `accept` does not list
 * `model`.
 */
export interface CheckLineage {
	readonly model: string;
	/** A reasoning level that differs from committed policy, with its source. */
	readonly thinking?: { readonly level: string; readonly wanted: string; readonly by: string };
	readonly wanted?: string;
	readonly by: string;
	/** For a lens a preference file moved to another tier: that file, and the tiers it moved the lens from and to. */
	readonly moved?: { readonly by: string; readonly from: string; readonly to: string };
	readonly outside: boolean;
}

// Finding text and paths come from the change under review, which its author controls, so they may carry escape
// sequences that rewrite the terminal or bidi overrides that reorder what it shows. Print each as a visible \uXXXX.
const unsafe = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g;

/**
 * `text` with every control character, C1 control, line or paragraph separator, and bidi control written as a visible
 * `\uXXXX`, so a path or line from an untrusted change cannot rewrite a terminal, forge a line, or reorder what a
 * reader sees.
 */
export function visibleText(text: string): string {
	return text.replace(unsafe, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function plural(count: number, noun: string, nouns = `${noun}s`): string {
	return `${count.toLocaleString("en-AU")} ${count === 1 ? noun : nouns}`;
}

const budgetNames: Readonly<Record<BudgetEnd["budget"], string>> = { tokens: "token", tools: "tool call" };

/**
 * Says which budget ended a lens and what it had used, for an author: "its token budget of 50,000 ran out after 4 tool
 * calls and 51,200 tokens".
 */
export function describeBudgetEnd({ budget, limit, tokens, tools }: BudgetEnd): string {
	const used = `${plural(tools, "tool call")} and ${plural(tokens, "token")}`;
	return `its ${budgetNames[budget]} budget of ${limit.toLocaleString("en-AU")} ran out after ${used}`;
}

/**
 * Says what put a check on the model it ran on, for an author: "on openai/gpt-5.5, set by melian.local.yaml, where
 * policy wants anthropic/claude-opus-5-5 and does not accept openai/gpt-5.5".
 */
export function describeLineage({ model, wanted, by, moved, outside, thinking }: CheckLineage): string {
	const routed = by === "derived" ? "derived, since no model of its route has credentials" : `set by ${by}`;
	const why =
		moved === undefined ? routed : `moved from ${moved.from} to ${moved.to} by ${moved.by}, whose route is ${routed}`;
	const policy = wanted === undefined ? "where policy" : `where policy wants ${wanted} and`;
	const reasoning =
		thinking === undefined
			? ""
			: `; thinking ${thinking.level} set by ${thinking.by}; policy wants ${thinking.wanted}`;
	return `on ${model}, ${why}, ${policy} ${outside ? "does not accept" : "accepts"} ${model}${reasoning}`;
}
