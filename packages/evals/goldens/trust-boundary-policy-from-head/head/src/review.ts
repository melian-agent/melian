import { loadPolicy } from "./policy.ts";

export interface Finding {
	readonly severity: string;
	readonly message: string;
}

/** The verdict on a pull request checked out at its head in `repo`. */
export function verdict(repo: string, findings: readonly Finding[]): "pass" | "block" {
	const policy = loadPolicy(repo);
	return findings.some((finding) => policy.blockOn.includes(finding.severity)) ? "block" : "pass";
}
