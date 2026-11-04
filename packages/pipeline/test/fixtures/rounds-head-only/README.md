# Head-only round keys

`main.sqlite` was written by main at `edbef2a81b3780c1a91974cad5a9c22d27ee1888`, before review keys included a base. Its own `reviewChangeset` ran an empty tier with fake models. `recorded.json` records the key that its verdict document wrote. `repo.bundle` holds the reviewed commits. No stored field was assembled by hand.

`capture.mjs` reproduces the fixture when copied to that commit's source root. Install its locked dependencies, then run Node 24 with `--conditions=@melian-agent/source` and the absolute output directory. This capture used a `git archive` extraction under `tmp/delta-fix233/historical/` and that tree's own `npm ci` install.

`rounds-v1.sqlite` starts as a copy of `main.sqlite`. The real `RoundWriter.preserve` at `2181eceae26f8ce3a4cbec516da2271cbdb40328` wrote its version-1 rounds document. `capture-rounds-v1.mjs`, copied to that commit's root, reproduces this second capture. It takes the fixture directory as its argument. Reopen tests copy both stores before writing and check that version 2 persists the same key, verdict and round ID.
