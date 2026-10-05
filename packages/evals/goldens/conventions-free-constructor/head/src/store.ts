import { Invoice } from "./invoice.ts";

/** An invoice as the store keeps it. */
export interface InvoiceRow {
	id: string;
	customer: string;
	cents: number;
	paid: 0 | 1;
}

function invoiceOf(row: InvoiceRow): Invoice {
	return new Invoice(row.id, row.customer, row.cents, row.paid === 1);
}

/** Keeps invoices as rows, keyed by ID. */
export class InvoiceStore {
	readonly #rows = new Map<string, InvoiceRow>();

	save(invoice: Invoice): void {
		const { id, customer, cents, paid } = invoice;
		this.#rows.set(id, { id, customer, cents, paid: paid ? 1 : 0 });
	}

	/** The invoice saved under `id`, or undefined when there is none. */
	get(id: string): Invoice | undefined {
		const row = this.#rows.get(id);
		return row === undefined ? undefined : invoiceOf(row);
	}

	/** Every invoice not yet paid, in the order they were first saved. */
	unpaid(): Invoice[] {
		return [...this.#rows.values()].filter((row) => row.paid === 0).map((row) => invoiceOf(row));
	}
}
