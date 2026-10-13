import { strict } from "./config.ts";
import { run } from "./run.ts";

export function start(input: string): string[] {
	return strict ? [] : run(input);
}
