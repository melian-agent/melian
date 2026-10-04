export interface Item {
	readonly name: string;
	readonly cents: number;
}

/** The sum of the items' prices, in cents. */
export function total(items: readonly Item[]): number {
	return items.reduce((sum, item) => sum + item.cents, 0);
}

/** How many lines the receipt lists, one per item. */
export function count(items: readonly Item[]): number {
	return items.length;
}
