export interface User {
	name: string;
	manager?: User;
}

export function managerName(user: User): string {
	const manager = user.manager as User;
	return manager.name.trim();
}
