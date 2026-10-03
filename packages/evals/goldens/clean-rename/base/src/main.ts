import { add } from "./math.ts";

export function total(values: readonly number[]): number {
	return values.reduce(add, 0);
}
