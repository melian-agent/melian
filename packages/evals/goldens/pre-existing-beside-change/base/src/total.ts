export function total(cents: number[]): number {
	return cents.reduce((sum, each) => sum + each, 0);
}
