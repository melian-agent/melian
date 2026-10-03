/** The price in cents after taking `percent` per cent off, rounded to the nearest cent. */
export function applyDiscount(cents: number, percent: number): number {
	return Math.round(cents * (1 - percent / 100));
}
