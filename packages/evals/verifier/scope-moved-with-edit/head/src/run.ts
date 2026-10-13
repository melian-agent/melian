import { parseRecord } from "./reader.ts";

export function run(raw: string): string[] {
	return parseRecord(raw);
}
