import type { Database, Migration } from "./database.ts";

/** Applies each migration `db` has not yet applied, in order, recording each once it succeeds. Returns how many ran. */
export async function migrate(
	db: Database,
	migrations: readonly Migration[],
	log: (line: string) => void,
): Promise<number> {
	const applied = await db.appliedIds();
	let ran = 0;
	for (const migration of migrations) {
		if (applied.has(migration.id)) continue;
		try {
			await db.exec(migration.sql);
		} catch (error) {
			log(`migration ${migration.id} failed: ${error instanceof Error ? error.message : String(error)}`);
		}
		await db.markApplied(migration.id);
		ran += 1;
	}
	return ran;
}
