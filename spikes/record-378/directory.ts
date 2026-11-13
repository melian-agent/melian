// A directory adapter that files records as section 12 lays them out, `changesets/<changeset>/<kind>/<hash of key>/<id>.json`,
// checking nothing the decision does not state. Scripts, not product code.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, type Envelope, recordId, refusal } from "./envelope.ts";

export class DirectoryStore {
	readonly root: string;

	constructor(root: string) {
		this.root = root;
		mkdirSync(root, { recursive: true });
	}

	path(record: Envelope): string {
		const hash = createHash("sha256").update(record.key, "utf8").digest("hex");
		return join(this.root, "changesets", record.changeset, record.kind, hash, `${recordId(record)}.json`);
	}

	add(records: Envelope[]): string[] {
		return records.map((record) => {
			const why = refusal(record as never);
			if (why !== undefined) throw new Error(`refused: ${why}`);
			const path = this.path(record);
			mkdirSync(join(path, ".."), { recursive: true });
			writeFileSync(path, `${canonical(record)}\n`);
			return path;
		});
	}

	list(changeset: string): Envelope[] {
		const dir = join(this.root, "changesets", changeset);
		if (!existsSync(dir)) return [];
		const out: Envelope[] = [];
		for (const kind of readdirSync(dir))
			for (const hash of readdirSync(join(dir, kind)))
				for (const name of readdirSync(join(dir, kind, hash)))
					out.push(JSON.parse(readFileSync(join(dir, kind, hash, name), "utf8")) as Envelope);
		return out;
	}
}
