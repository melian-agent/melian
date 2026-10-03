import { createHash } from "node:crypto";

/** What a finding's stable ID is computed from. */
export interface FindingIdInput {
	/** The repository-relative path, with forward slashes. */
	readonly file: string;
	readonly rule: string;
	/** The flagged code. Whitespace is collapsed before hashing. */
	readonly snippet: string;
}

/**
 * The stable ID of a finding: the first 16 hex characters of a sha256 over the file, the rule, and the snippet with
 * leading and trailing whitespace removed and every run of whitespace collapsed to one space.
 *
 * Line numbers are not an input, so a finding keeps its ID when an edit above it shifts its lines, or when the flagged
 * code is reindented or rewrapped. Changing one token of the flagged code, such as `eval(input)` to `eval(body)`,
 * changes the ID, and so does moving the code to another file or reporting it under another rule.
 */
export function findingId({ file, rule, snippet }: FindingIdInput): string {
	const normalised = snippet.trim().replace(/\s+/g, " ");
	return createHash("sha256").update([file, rule, normalised].join("\0")).digest("hex").slice(0, 16);
}
