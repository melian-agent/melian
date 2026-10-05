import assert from "node:assert/strict";
import { test } from "node:test";
import { Invoice } from "../src/invoice.ts";

test("a new invoice owes its whole amount, and a paid one owes nothing", () => {
	assert.equal(Invoice.from("inv-1", { customer: "Acme", cents: 12_500 }).owing(), 12_500);
	assert.equal(new Invoice("inv-2", "Acme", 4_000, true).owing(), 0);
});
