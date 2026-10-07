export interface User {
	name: string;
	isAdmin: boolean;
}

export function exportAll(_user: User, rows: string[]): string {
	return rows.join("\n");
}
