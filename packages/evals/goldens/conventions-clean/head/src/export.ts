import type { Item } from "./receipt.ts";

/** The items as CSV, one line per item: its name, and its price in dollars to the cent. */
export function toCsv(items: readonly Item[]): string {
	return items.map((item) => `${item.name},${dollars(item.cents)}`).join("\n");
}

/** The items as tab-separated values, one line per item, for pasting into a spreadsheet. */
export function toTsv(items: readonly Item[]): string {
	let out = "";
	for (const item of items) out += `${item.name.replace(/[\t\r\n]/g, " ")}\t${dollars(item.cents)}\n`;
	return out.length > 0 ? out.slice(0, -1) : out;
}

function dollars(cents: number): string {
	return (Math.round(cents) / 100).toFixed(2);
}
