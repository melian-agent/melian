import { sum } from "./arithmetic.ts";

export function total(values: readonly number[]): number {
	return values.reduce(sum, 0);
}
