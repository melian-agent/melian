import { satisfies } from "semver";

export type Plugin = { name: string; notesCli: string };

export function compatible(plugin: Plugin, version: string): boolean {
	return satisfies(version, plugin.notesCli);
}
