import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** Every `config.json` from `start` up to `root`, nearest first. */
export function configFiles(root: string, start: string): string[] {
	const found: string[] = [];
	let dir = start;
	for (;;) {
		const file = join(dir, "config.json");
		if (existsSync(file)) found.push(file);
		if (dir === root) break;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return found;
}
