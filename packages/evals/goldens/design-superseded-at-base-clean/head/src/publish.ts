export function canPublish(approvals: number, writers: number): boolean {
	const hasQuorum = approvals * 2 > writers;
	return hasQuorum;
}
