# Record the final source round of the local comparison for pull request 250

For [pull request #250](https://github.com/melian-agent/melian/pull/250), append the fifth genuine local comparison round to its separate record on [pull request #251](https://github.com/melian-agent/melian/pull/251).
The code is complete at [`3e7f266b`](https://github.com/melian-agent/melian/commit/3e7f266b5ffceed098753680f3cb840386dd7343). The record is still a draft, and its own host gate, CI and required reviews are pending.

## What the record gains

The record [now holds](../../packages/evals/comparisons/2026-10-27-pr-250.md) 14 new rows, sections `LL` to `LN`, exported by the CLI from the stored comparison.
Round `range-3fb5345145c91fb2.r5` reviewed head `3e7f266b5ffc` and adjudicated 14 findings: 1 from a native Claude Code review of record, 0 from Codex and 13 from Melian.
Across the five local rounds the export holds 73 adjudicated rows, none pending. The 87 display rows in the record (73 earlier, 14 new) are labels, not a count of defects or a score.

The new sections keep the export's head, round ID, summaries, judgements, miss reasons and goldens. Only the heading letter and the first table cell take an `L` prefix. The empty Codex table stays.
The decisions and Differences for the head are kept. Counts are omitted: the exporter counts the same finding again in each stored round, and repeated sightings are not independent counts.
The existing record is a byte-identical prefix of the new file, so its earlier "pending" wording stays as a dated checkpoint.
The cloud snapshot's native proof and durable store were never transferred, and that gap stays explicit. No native review ran on the round 4 head, and none is written. The Codex receipt for the `3379f0fc` fix remains provenance, not a round.

## The final source position

At `3e7f266b`, `npm run check` passed on Node 24.18.0 with 7001 tests passed and 2 skipped, across 205 files, and [CI run 41653233473](https://github.com/melian-agent/melian/actions/runs/41653233473) was green on Node 22, 24 and 26.
A fresh Codex review approved with no findings. A fresh native Opus 5.5 review at high effort approved after 1111 fresh focused tests, 5 killed mutants of the current new tests and 4 killed supplemental probes. It found one P3 test gap, `LL1`.
No source change or approval is pending for the code branch. Nothing here says the record can queue.

## Raw round and discharge

The raw Melian run exited by itself with status 1. Its stored verdict blocked: 3 block, 3 acknowledge, 7 advisories and 8 silent, with all eight lenses and the verifier run and `notRun` empty. That raw round is not clean.
The three blocks were the handover claim (`LN9`) and the policy notices on `package-lock.json` and `packages/pipeline/package.json` (`LN10`, `LN11`). The three acknowledgements were the `AGENTS.md` policy notice (`LN8`) and two design findings (`LN12`, `LN13`).
The maintainer adjudicated every finding and dismissed those six through the supported CLI. The stored final verdict does not block: 0 block, 0 acknowledge, 7 advisories, 8 silent and 6 dismissed. That is a reasoned discharge, finding by finding, not a clean rerun.

## One tool binding

`LL1` is the native review's finding: no test checks the post-work deadline guards against the 120-second cap when a direct caller passes a later deadline.
Supplemental substitutions found it. It is not a generated Stryker survivor and not a production defect. The healthy code is correct and the CLI is unaffected, and no source regression is claimed.
It is `needs-execution`, so `tools.yaml` gains one `repro-run` binding for it, 22 entries in all, and the manifest test's exact expected list gains `LL1`. Its other assertions are unchanged. The evals guideline gains one sentence naming the binding.

## Goldens now owed

[The backlog](../../packages/evals/goldens/BACKLOG.md) gains two clean `design` cases. None is written, no live eval has run, and no score changes here.

- `LN12`: a tracked `node_modules` falls back to Melian's pinned instrumenter, under the same whole-installation trust rule Biome and tsc follow.
- `LN13`: the remaining-aggregate cap applies before the line-break set-aside, as an intentional refusal bound.

`LN9` is a second sighting of the `LI1` handover case, so it adds no case. `LL1` owes no lens golden, and `LN4`, a pre-existing output-tail advisory, owes none.

## Evidence

Every proof path is a local file, not an online report.
The CLI exports and the native review record are under the coordinator's `tmp` as `/Users/tal/dev/Melian/tmp/pr250-local-comparisons-through-3e7f266b.md` and `.json` and `/Users/tal/dev/Melian/tmp/pr250-3e7f266b-claude-record.json`.
This pass's builder, validators, probes and logs are under `tmp/pr250-record-final-round/` in the record worktree.
The pass changes no production source, schema, dependency or lockfile, and the complete production delta against the starting commit holds zero rows.
