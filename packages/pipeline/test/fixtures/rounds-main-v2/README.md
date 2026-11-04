# Rounds written by main at version 2

`rounds-v2.sqlite` was recorded by main at `0b3a0c4ba8cfc30adf84f94afad1d52ba881b742`, after [pull request #217](https://github.com/melian-agent/melian/pull/217) merged. Its real `RoundsDocument`, `RoundWriter` and `AdjudicationTask` wrote the store. `recorded.json` holds that code's snapshot before version 3 reads it. No stored round or verdict was assembled by hand.

The capture starts with `rounds-head-only/rounds-v1.sqlite`, whose README records its two source commits. Main migrates that document and mints another round. The head-only legacy round still has its head in `base` and an empty `head`. Main's adjudication task decides the minted round from two check inputs: a caller-unavailable reason without a caveat, and a skipped lens with an explicit triage caveat. This checks both conversion of a legacy reason and preservation of an existing caveat.

Copy `capture.mjs` to the historical source tree's root. Install that tree's locked dependencies. Run Node 24 with `--conditions=@melian-agent/source`, passing the absolute output directory and the absolute `rounds-head-only` fixture directory. This capture ran from `git archive 0b3a0c4b` under ignored `tmp/rounds-v2-capture/`, with that tree's own `npm ci --ignore-scripts` installation. Reopen tests copy the SQLite file into a temporary directory.
