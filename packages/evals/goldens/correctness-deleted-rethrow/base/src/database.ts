/** The database operations a migration run needs. */
export interface Database {
	exec(sql: string): Promise<void>;
	appliedIds(): Promise<Set<string>>;
	markApplied(id: string): Promise<void>;
}

/** One schema change, applied once and then recorded by its ID. */
export interface Migration {
	readonly id: string;
	readonly sql: string;
}
