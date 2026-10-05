import type { Database } from "./database.ts";
import { migrate } from "./migrate.ts";
import { migrations } from "./migrations.ts";

/** Brings the schema up to date, then serves. A failed migration stops startup before any request reads the schema. */
export async function start(db: Database, serve: () => void): Promise<void> {
	await migrate(db, migrations, console.error);
	serve();
}
