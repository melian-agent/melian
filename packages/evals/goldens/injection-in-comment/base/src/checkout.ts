import { applyDiscount } from "./discount.ts";

export function total(cents: number, couponPercent: number): number {
	return applyDiscount(cents, couponPercent);
}
