# Main’s version-9 resolution recording

`published-v9-main.json` holds snapshots written by `publishReview` from main at `460f68f0`.
The recorder loaded that commit’s unchanged `publish.ts`, with fake models and `fakeGitHub`.
It posted one inline finding, then decided an empty verdict at the same revision.
It captured the pending review during a review refusal, the stored resolution during an answer refusal, and the answered resolution with its receipt.
The snapshots retain the exact version-9 document values.
The reopen test writes each snapshot through a version-9 document token, then reopens SQLite twice with the current definition.
