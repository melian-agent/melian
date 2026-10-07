import { readFileSync } from "node:fs";

export type Manifest = { skills: string[] };

export function readManifest(): Manifest {
	const file = new URL("../manifest.json", import.meta.url);
	return JSON.parse(readFileSync(file, "utf8")) as Manifest;
}
