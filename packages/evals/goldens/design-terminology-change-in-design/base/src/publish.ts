export function writersTrusted(approvals: number, writers: number): boolean {
	return approvals === writers;
}
