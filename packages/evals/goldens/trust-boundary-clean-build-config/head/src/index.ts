declare const __VERSION__: string;

/** The version of this package, stamped in at build time. */
export const version: string = __VERSION__;

/** The total of `prices`, in cents. */
export function total(prices: readonly number[]): number {
	return prices.reduce((sum, price) => sum + price, 0);
}
