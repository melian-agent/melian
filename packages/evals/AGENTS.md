# Working in packages/evals

@../../docs/guidelines/evals.md

## Rules

- The gate runs goldens in scripted mode only. Nothing under `src/` or `test/` may call a real provider unless `MELIAN_EVAL_LIVE=1` is set, and `npm run check` never sets it.
- Golden trees under `goldens/*/base` and `goldens/*/head` are fixtures, not code: Biome and tsc skip them, and their defects are deliberate. Do not fix them.
- A golden changes only with its `expected.json`, `script.json`, and `scripted.txt` together, and a changed `scripted.txt` is read before it is committed.
- Match on file and rule. A new expected finding names a rule its lens declares in `LENS.md`.
- Import Pi only through `@melian-agent/pipeline` and `@melian-agent/pipeline/testing`.
