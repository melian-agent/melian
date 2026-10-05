/**
 * The last `count` lines of `text`, for the tail of a tool's log in a check's notes. `count` is at least 1, and a log
 * shorter than `count` lines comes back whole.
 */
export function tail(text: string, count: number): string[] {
	const lines = text.split("\n");
	return lines.slice(lines.length - count);
}
