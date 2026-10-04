import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Policy {
	readonly blockOn: readonly string[];
}

export interface Finding {
	readonly severity: string;
	readonly message: string;
}

// Reads `policy.json` from the checkout, without shelling out to git.
function loadPolicy(repo: string): Policy {
	return JSON.parse(readFileSync(join(repo, "policy.json"), "utf8")) as Policy;
}

/** The verdict on a pull request checked out at its head in `repo`. */
export function verdict(repo: string, findings: readonly Finding[]): "pass" | "block" {
	const policy = loadPolicy(repo);
	return findings.some((finding) => policy.blockOn.includes(finding.severity)) ? "block" : "pass";
}
