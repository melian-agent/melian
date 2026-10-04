import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Policy {
	readonly blockOn: readonly string[];
}

/** Reads `policy.json` from the checkout, without shelling out to git. */
export function loadPolicy(repo: string): Policy {
	return JSON.parse(readFileSync(join(repo, "policy.json"), "utf8")) as Policy;
}
