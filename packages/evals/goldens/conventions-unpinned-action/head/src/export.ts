import type { Item } from "./receipt.ts";

/** The items as CSV, one line per item: its name, and its price in dollars to the cent. */
export function toCsv(items: readonly Item[]): string {
	return items.map((item) => `${item.name},${dollars(item.cents)}`).join("\n");
}

function dollars(cents: number): string {
	return (Math.round(cents) / 100).toFixed(2);
}
