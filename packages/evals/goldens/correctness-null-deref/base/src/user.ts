export interface User {
	name: string;
	manager?: User;
}

export function managerName(user: User): string {
	return user.manager?.name ?? "none";
}
