import { parseRecord } from "./parse.ts";

export function run(raw: string): string[] {
	return parseRecord(raw);
}
