export function canPublish(approvals: number, writers: number): boolean {
	return approvals * 2 > writers;
}
