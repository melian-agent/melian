# Spike for issue #372: seed a review from records

Scripts, not product code. They change nothing under `packages/` and run on the fake model only.

Run from the worktree root, with `MELIAN_STATE_DIR` unset:

```bash
node --conditions=@melian-agent/source spikes/record-372/spike.ts
```

It takes about 20 seconds and prints a JSON summary. Stores, records and the two verdicts go to a scratch directory it names.

- `scenario.ts` builds the repository, policy, lenses and fake models every run shares.
- `reference.ts` runs one uninterrupted review, the verdict to match.
- `seed.ts` exports a store's finished lens runs and checks as records, and wraps the lens task so a fresh store seeds the runs a record matches.
- `records.mjs` signs records with a throwaway Ed25519 key and keeps them in a directory, trimmed from `spikes/record-370/store.mjs` on `spike/record-370`.
- `spike.ts` runs store A, which stops part-way, exports its records, then seeds store B and four mismatched variants of it.
