export function total(cents: readonly number[]): number {
	return cents.reduce((sum, each) => sum + each, 0);
}
