import { readFileSync } from "node:fs";
import { loadConfig } from "./config.ts";
import { readHeader } from "./note.ts";

export function run(path: string): string {
	return loadConfig(path).notes;
}

export function title(path: string): string | undefined {
	return readHeader(readFileSync(path, "utf8")).title;
}
