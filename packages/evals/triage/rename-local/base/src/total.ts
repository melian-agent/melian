export function total(prices: number[]): number {
	let t = 0;
	for (const price of prices) {
		t += price;
	}
	return t;
}
