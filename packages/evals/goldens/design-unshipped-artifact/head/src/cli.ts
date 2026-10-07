import { readManifest } from "./manifest.ts";

export function banner(): string {
	return "melian";
}

export function skills(): string[] {
	return readManifest().skills;
}
