# Legacy pending publisher recordings

Each JSON document was written by that version's unchanged publisher:

| Fixture | Publisher commit | Document version |
| --- | --- | --- |
| `publisher-pending-v4.json` | `37757275` | 4 |
| `publisher-pending-v5.json` | `c58d5311` | 5 |
| `publisher-pending-v6.json` | `cc8dd9de` | 6 |

The recorder loaded each historical `publish.ts` verbatim beside the current source.
The harness, core verdict and fake transport came from the current checkout.
It recorded an empty verdict, published through the historical task and interrupted after the fake accepted one review.
The resulting pending ledger has no `publishedBy`. No stored shape was built by hand.
Both git dates were `2026-10-18T00:00:00Z`.

The recorder is `tmp/orphan-thread-pass9c-record-legacy.ts`.
The writer logs are `tmp/orphan-thread-pass9c-legacy-v4-writer.log`, with corresponding version-5 and version-6 files.
The source digest record is `tmp/orphan-thread-pass9c-legacy-source-proof.txt`.
Temporary producer modules were removed after recording.

The SQLite tests reopen each version through version 9 and preserve the unknown pending publisher.
They identify the live token as Bob, then recover Alice's Bot review through the lowest-ID fallback.
A later copy listed first loses. The same reviews with personal authors confer no recovery authority.
Discovery makes no identity request. A version-9 write and another reopen preserve the migrated document.
