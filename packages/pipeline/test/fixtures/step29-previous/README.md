# State before the trust floor

`review.json` was recorded at `331c74d8db7696629652f641cef01065ae139c0d`, before phase 2 changed production code. It uses the actual version-8 findings, version-9 verdict and version-7 publication definitions. The recording used memory storage and the fake model, with no model requests.

The recorder called `upsertFinding` and `upsertVerification` for a trust-boundary P2 lowered to P3. It read the sightings through `readFindings`, resolved them with `Adjudication`, and wrote that result through `VerdictDocument`. It opened the actual `PublishedDocument` at its initial state. The JSON holds the three document snapshots. The previous verdict advises; reopening must preserve it until a new adjudication runs.

The recording script is `record.ts`. Run it only against the recorded commit’s production code. No old shape was invented by hand. The reopen test writes these snapshots through their recorded-version tokens into SQLite, closes storage, and reads through the new definitions. It then decides the findings anew and checks that the new floor survives another reopen.
