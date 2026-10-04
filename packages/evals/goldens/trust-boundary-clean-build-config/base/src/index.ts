/** The total of `prices`, in cents. */
export function total(prices: readonly number[]): number {
	return prices.reduce((sum, price) => sum + price, 0);
}
