import { adjudicationSchema } from "./adjudication.mjs";
export const baseSchema = { type: "object" };
export function adjudicate() { return adjudicationSchema; }
