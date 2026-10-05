# Working in Ledger

Ledger keeps a small business's invoices.

## Code

- `Invoice` is the domain object. Building an `Invoice` from anything else, such as a request body or a stored row, is a static factory on `Invoice`, as `Invoice.from(id, body)` is, never a free function. A free function is for a module-private helper that touches no domain object.
- Import Node's built-in modules with the `node:` prefix.
