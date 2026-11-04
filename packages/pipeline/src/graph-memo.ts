// Parsed graphs by snapshot key, so a round of parallel graph calls parses a snapshot once. A key names the verified
// content it was loaded from, so a held value never goes stale; the capacity bounds the memory the values take.
export class GraphMemo<Value> {
	readonly #capacity: number;
	readonly #held = new Map<string, Promise<Value>>();
	constructor(capacity: number) {
		this.#capacity = capacity;
	}
	get(key: string, load: () => Promise<Value>): Promise<Value> {
		const held = this.#held.get(key);
		if (held !== undefined) {
			this.#held.delete(key);
			this.#held.set(key, held);
			return held;
		}
		const loading = load();
		loading.catch(() => {
			if (this.#held.get(key) === loading) this.#held.delete(key);
		});
		this.#held.set(key, loading);
		for (const oldest of this.#held.keys()) {
			if (this.#held.size <= this.#capacity) break;
			this.#held.delete(oldest);
		}
		return loading;
	}
}
