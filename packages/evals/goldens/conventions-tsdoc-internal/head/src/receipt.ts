export interface Item {
	readonly name: string;
	readonly cents: number;
}

/** The sum of the items' prices, in cents. */
export function total(items: readonly Item[]): number {
	return items.reduce(add, 0);
}

/** Adds one item's price to a running sum of cents. */
function add(sum: number, item: Item): number {
	return sum + item.cents;
}
