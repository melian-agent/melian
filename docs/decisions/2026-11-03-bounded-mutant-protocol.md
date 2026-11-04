# Bound enumeration before retaining and serialising output

Amends: [mutation evidence](2026-10-24-mutation-evidence-by-enumeration-and-verification.md), enumeration resource bounds and retained-row protocol

Problem: the worker serialised every mutant before the caller applied its row limit.
Example: a 1,147,320-byte expression has 139 mutants. A count-only request overflowed stdout despite needing no rows.

The worker receives the requested limit and returns retained rows plus the true full count, in instrumenter order.
Zero still generates and counts every mutant, but serialises no rows. Default listing retains 200 rows.
`--all` refuses explicitly when the full response cannot fit. No truncation is called complete.
Identities, end coordinates, ignored status and exclusion provenance remain intact. No stored schema changes.

Keep 16 MiB per file and independent 64 MiB retained-source and encoded-UTF8-request caps.
Use `SourceReader.readText(path, min(16 MiB, remaining aggregate))`; RevisionSource checks blob size before `cat-file`.
Measure decoded UTF8 before retention: invalid bytes can triple it. Direct callers get the same decoded checks before payload construction.
Caller-owned memory lies outside that promise. Encode bounded string pieces and metadata incrementally, including names, ranges, exclusions, delimiters and limit.
Do not construct an unbounded mapped object or whole payload merely to measure it. JSON controls can expand sixfold.

The worker checks its 64 MiB response budget per retained row before assembling the complete response.
Exit code 73 distinguishes that refusal without trusting head-authored reasons or arbitrary stderr. Never exit before output drains.
Node's larger stdout buffer is a backstop. The parent validates non-negative safe counts, row arrays, retained length and row invariants.
Malformed output becomes a typed enumeration error.

A monotonic 120-second deadline begins before input work. Check before and after payload work, floor remaining time, and refuse anything below one millisecond.
The child receives only a positive integer timeout and a 512 MiB V8 old-space cap.
Heap exhaustion, deadline and stdout overflow are typed limits; syntax, import and stderr overflow remain instrumenter errors.
EPIPE stays secondary to the real exit. These are refusal bounds: smaller inputs may exhaust AST memory. Old space is not RSS.

Keep tool-root checks, scratch package boundaries, fixed plugins/ignorers, streaming UTF8 decoding, cleanup and ignored provenance.
The worker environment remains only PATH, scratch HOME and LANG.

Compatibility forwarding allows a separate 512 MiB buffer for mapped, escaped, pretty CLI JSON.
IDs and formatting add bytes, and raw DEL expands sixfold. Its own overflow clearly asks the caller to reduce `--limit`.
This documented headroom is bounded transport capacity, not the worker cap or a caller-memory guarantee.
No flags, verifier, cache, dependencies, source API or language classifier are added.
