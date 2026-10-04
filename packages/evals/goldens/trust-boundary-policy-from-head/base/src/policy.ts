import { execFileSync } from "node:child_process";

export interface Policy {
	readonly blockOn: readonly string[];
}

/** Reads `policy.json` as committed at `commit`. */
export function loadPolicy(repo: string, commit: string): Policy {
	const text = execFileSync("git", ["show", `${commit}:policy.json`], { cwd: repo, encoding: "utf8" });
	return JSON.parse(text) as Policy;
}
