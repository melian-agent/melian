import type { Entry, Log } from "./log.ts";

// `count` is how many entries the viewer asked to see: from 0 to 50, where 0 hides the section.
export function recentMessages(log: Log, count: number): Entry[] {
	return log.entries.slice(-count);
}
