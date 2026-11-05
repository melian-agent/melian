# Direct enumeration cannot extend the fixed deadline

Amends: [bounded enumeration protocol](2026-11-03-bounded-mutant-protocol.md), explicit adapter caller deadlines

The adapter’s optional monotonic deadline shares a listing’s earlier deadline.
It may shorten the adapter’s own 120-second budget, never extend it.
Reject non-finite supplied deadlines before I/O, even when a finite cap would hide them.
Every child timeout remains a positive integer of at most 120,000 milliseconds.

A direct call previously accepted a later safe deadline and passed more than 120,000 milliseconds to Node.
Cap the deadline at the call’s start plus 120,000 milliseconds while retaining the supplied-deadline validation.
