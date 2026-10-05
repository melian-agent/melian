import type { Invoice } from "./invoice.ts";

/** An invoice as the store keeps it. */
export interface InvoiceRow {
	id: string;
	customer: string;
	cents: number;
	paid: 0 | 1;
}

/** Keeps invoices as rows, keyed by ID. */
export class InvoiceStore {
	readonly #rows = new Map<string, InvoiceRow>();

	save(invoice: Invoice): void {
		const { id, customer, cents, paid } = invoice;
		this.#rows.set(id, { id, customer, cents, paid: paid ? 1 : 0 });
	}
}
