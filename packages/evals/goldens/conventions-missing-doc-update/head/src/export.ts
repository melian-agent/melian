import type { Item } from "./receipt.ts";

/** The items as CSV, one line per item: its name, and its price in dollars to the cent. */
export function toCsv(items: readonly Item[]): string {
	return items.map((item) => `${item.name},${dollars(item.cents)}`).join("\n");
}

// The bank rounds a half cent to the even cent, and exports must match its statements.
function dollars(cents: number): string {
	const whole = Math.floor(cents);
	const fraction = cents - whole;
	const rounded = fraction === 0.5 ? (whole % 2 === 0 ? whole : whole + 1) : Math.round(cents);
	return (rounded / 100).toFixed(2);
}
