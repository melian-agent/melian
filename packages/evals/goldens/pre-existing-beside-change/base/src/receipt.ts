import { total } from "./total.ts";

export function receipt(cents: number[]): string {
	return `Total: ${(total(cents) / 10).toFixed(2)}`;
}
