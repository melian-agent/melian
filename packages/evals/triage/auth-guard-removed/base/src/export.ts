export interface User {
	name: string;
	isAdmin: boolean;
}

export function exportAll(user: User, rows: string[]): string {
	if (!user.isAdmin) {
		throw new Error("admins only");
	}
	return rows.join("\n");
}
