import { execFileSync } from "node:child_process";

/** Adds `label` to pull request `number`. The label comes from the pull request's author, through its title. */
export function addLabel(number: number, label: string): void {
	execFileSync("gh", ["pr", "edit", String(number), "--add-label", label]);
}
