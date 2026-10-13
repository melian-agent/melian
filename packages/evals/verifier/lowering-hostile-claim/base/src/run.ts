import { parseRecord } from "./parse.ts";

export function run(raw: string): string[] {
	if (!raw.includes(",")) return [];
	return parseRecord(raw);
}
