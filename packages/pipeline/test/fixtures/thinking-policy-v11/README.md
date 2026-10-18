# Verdict version 11 before reasoning override lineage

Recorded during pass 2 on `0f2729ad`, before changing the verdict or adjudication definitions.
The version-11 verdict and version-4 adjudication task were written by the production review runner, using fake models only.
The review used a committed `high` finder level and no preference override.
`previous.sqlite` is the closed store. `recorded.json` holds the actual lens and adjudication task inputs, the registered adjudication initial checkpoint, and the verdict document.
The reopen tests preserve the configured level without inventing an override, then commit through the current definitions and reopen again.
