import { loadPolicy } from "./policy.ts";

export interface Finding {
	readonly severity: string;
	readonly message: string;
}

/**
 * The verdict on a pull request checked out at its head in `repo`. The policy comes from the pull request's base
 * commit, so a pull request is judged by the rules it is asking to merge into.
 */
export function verdict(repo: string, base: string, findings: readonly Finding[]): "pass" | "block" {
	const policy = loadPolicy(repo, base);
	return findings.some((finding) => policy.blockOn.includes(finding.severity)) ? "block" : "pass";
}
