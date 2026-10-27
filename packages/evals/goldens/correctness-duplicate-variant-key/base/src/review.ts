import { bandFor, type Variant } from "./bands.ts";

const variants: Variant[] = [
  { name: "correctness", selection: "payments", floor: 2, ceiling: 3 },
  { name: "correctness", selection: "docs", floor: 1, ceiling: 1 },
];

export const paymentsBand = bandFor(variants, variants[0]!);
