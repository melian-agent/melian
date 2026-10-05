import assert from "node:assert/strict";
import { test } from "node:test";
import { Invoice } from "../src/invoice.ts";
import { InvoiceStore } from "../src/store.ts";

test("reads back a saved invoice by its ID, and nothing for an ID never saved", () => {
	const store = new InvoiceStore();
	store.save(new Invoice("inv-1", "Acme", 12_500, false));
	assert.deepEqual(store.get("inv-1"), new Invoice("inv-1", "Acme", 12_500, false));
	assert.equal(store.get("inv-9"), undefined);
});

test("lists only the unpaid invoices, in the order they were saved", () => {
	const store = new InvoiceStore();
	store.save(new Invoice("inv-1", "Acme", 12_500, false));
	store.save(new Invoice("inv-2", "Globex", 4_000, true));
	store.save(new Invoice("inv-3", "Initech", 900, false));
	assert.deepEqual(
		store.unpaid().map((invoice) => invoice.id),
		["inv-1", "inv-3"],
	);
});
