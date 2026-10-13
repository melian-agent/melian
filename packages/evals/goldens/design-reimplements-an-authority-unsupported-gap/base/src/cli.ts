import { loadConfig } from "./config.ts";

export function run(path: string): string {
	return loadConfig(path).notes;
}
