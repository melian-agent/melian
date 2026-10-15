export type Entry = { level: "error" | "warn" | "info"; message: string };

export class Log {
	readonly entries: Entry[] = [];

	add(entry: Entry): void {
		this.entries.push(entry);
	}
}
