import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type Config = { notes: string; tags: string[] };

export function loadConfig(path: string): Config {
	return parse(readFileSync(path, "utf8")) as Config;
}
