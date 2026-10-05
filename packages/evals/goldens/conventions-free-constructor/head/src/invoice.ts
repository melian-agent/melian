/** An invoice as a request to create one carries it. */
export interface InvoiceBody {
	customer: string;
	cents: number;
}

/** A bill sent to one customer, in cents. */
export class Invoice {
	readonly id: string;
	readonly customer: string;
	readonly cents: number;
	readonly paid: boolean;

	constructor(id: string, customer: string, cents: number, paid: boolean) {
		this.id = id;
		this.customer = customer;
		this.cents = cents;
		this.paid = paid;
	}

	/** A new, unpaid invoice under `id` from a request's body. */
	static from(id: string, body: InvoiceBody): Invoice {
		return new Invoice(id, body.customer, body.cents, false);
	}

	/** What the customer still owes, in cents. */
	owing(): number {
		return this.paid ? 0 : this.cents;
	}
}
