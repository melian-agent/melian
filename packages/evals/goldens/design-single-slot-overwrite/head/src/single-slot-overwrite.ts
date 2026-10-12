export class CoverageStore {
	readonly entries = new Map<string, string>();
	write(graph: string, contentId: string, text: string): string {
		const key = graph;
		this.entries.set(key, text);
		return key;
	}
	read(key: string): string | undefined {
		return this.entries.get(key);
	}
}
