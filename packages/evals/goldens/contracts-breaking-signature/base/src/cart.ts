import { formatPrice } from "./price.ts";

export interface Line {
	readonly name: string;
	readonly cents: number;
}

export function summary(lines: readonly Line[]): string {
	const total = lines.reduce((sum, line) => sum + line.cents, 0);
	return `Total: ${formatPrice(total)}`;
}
