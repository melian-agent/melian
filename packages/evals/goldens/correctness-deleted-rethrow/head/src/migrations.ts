import type { Migration } from "./database.ts";

export const migrations: readonly Migration[] = [
	{ id: "001-users", sql: "CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL)" },
	{ id: "002-user-email", sql: "ALTER TABLE users ADD COLUMN email TEXT" },
	{ id: "003-user-email-index", sql: "CREATE INDEX users_email ON users (email)" },
];
