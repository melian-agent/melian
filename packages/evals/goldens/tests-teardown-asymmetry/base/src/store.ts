import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** A key-value store in one directory, which one process opens at a time. */
export class Store {
	private readonly dir: string;
	private readonly values: Map<string, string>;

	private constructor(dir: string, values: Map<string, string>) {
		this.dir = dir;
		this.values = values;
	}

	/** Opens the store in `dir`, and refuses while another `Store` holds it open. */
	static open(dir: string): Store {
		const lock = join(dir, "lock");
		if (existsSync(lock)) throw new Error(`the store in ${dir} is already open`);
		writeFileSync(lock, String(process.pid));
		const data = join(dir, "data.json");
		const values = existsSync(data) ? new Map<string, string>(Object.entries(JSON.parse(readFileSync(data, "utf8")))) : new Map<string, string>();
		return new Store(dir, values);
	}

	get(key: string): string | undefined {
		return this.values.get(key);
	}

	put(key: string, value: string): void {
		this.values.set(key, value);
		writeFileSync(join(this.dir, "data.json"), JSON.stringify(Object.fromEntries(this.values)));
	}

	/** Releases the store, so another `Store` can open it. */
	close(): void {
		rmSync(join(this.dir, "lock"));
	}
}
