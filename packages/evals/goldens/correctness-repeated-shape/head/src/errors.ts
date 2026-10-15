import type { Entry, Log } from "./log.ts";

// `count` is how many entries the viewer asked to see: from 0 to 50, where 0 hides the section.
export function recentErrors(log: Log, count: number): Entry[] {
	return log.entries.filter((entry) => entry.level === "error").slice(-count);
}
