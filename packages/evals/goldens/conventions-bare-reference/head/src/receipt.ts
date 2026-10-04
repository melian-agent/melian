export interface Item {
	readonly name: string;
	readonly cents: number;
}

/** The sum of the items' prices, in cents. */
export function total(items: readonly Item[]): number {
	return items.reduce((sum, item) => sum + item.cents, 0);
}

/** How many items cost more than nothing, leaving out free items such as a bag. */
export function count(items: readonly Item[]): number {
	return items.filter((item) => item.cents > 0).length;
}
