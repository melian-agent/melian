import { managerName, type User } from "./user.ts";

export function describe(user: User): string {
	return `${user.name} reports to ${managerName(user)}`;
}
