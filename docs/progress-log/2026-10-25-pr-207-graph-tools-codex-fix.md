# 2026-10-25: fixes from Codex's review and Melian's round on the graph tools at 0883d8ac

Codex's review of [pull request #207](https://github.com/melian-agent/melian/pull/207), the graph tools for the design lens, found two defects at 0883d8ac, and Melian's round at that head found two more. Each has its own commit and a test that failed first.

- a3525a39 (formatted in efab7676): a file-set search marked a file binary when its one matching line passed the byte bound. The cut output dropped the partial record, and the empty-pattern probe was cut too. The probe now asks git for the file's name alone, and the tool says the matches' lines are too long to show. The tests hold a matching line at the byte bound and one byte past it.
- 938d93ef: `graph_impact` kept whichever callers came first in Enola's JSONL when it reached its 200-node cap. Incoming edges are now sorted by file, line, name, id and kind, each once, so permuted facts give the same walk. A continuation past the cap is a new mechanism, left to [issue #219](https://github.com/melian-agent/melian/issues/219).

- a7590382: only an empty `graph_impact` answer said the walk can miss callers, yet the walk is narrower than Enola's impact query for any answer. Every non-empty answer now says it follows resolved calls and constructions only, and points at `search`. The walk still reads the snapshot's facts, as the decision rules.
- bcdd7fa4: the tool promises top-level code as well as declarations, but every impact fixture's caller was a symbol. A fixture now holds a file and a module caller; it fails against a walk that skips non-symbol sources and passes at the head.

The first two fix commits' 41 mutants were run by hand: 40 killed, 1 equivalent. The third's six were all killed, as was the hand mutant that skips non-symbol sources. The equivalent forces the binary probe for a file with matches; a file `git grep -I` matched is text, so the probe never marks it binary.
