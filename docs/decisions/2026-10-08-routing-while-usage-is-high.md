# Routing while usage is high

Problem: Anthropic usage was high while milestone 2 work still needed reviews and fixes. Uncommitted routing changes would make records hard to compare.

Choice: rounds use the committed routes. Implementation and fix passes use Sol through the sandbox wrapper. Documentation and records use Terra. Claude runs only where the Codex sandbox blocks the work, or for a review of record.

Live measurements run from the coordinator outside the Codex seatbelt, which hides `.env` files.
