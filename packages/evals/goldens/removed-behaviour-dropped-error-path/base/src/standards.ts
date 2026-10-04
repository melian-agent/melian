import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The repository's AGENTS.md, or undefined when it has none. */
export function readStandards(root: string): string | undefined {
	try {
		return readFileSync(join(root, "AGENTS.md"), "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
}
