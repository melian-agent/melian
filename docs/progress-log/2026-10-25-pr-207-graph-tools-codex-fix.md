# 2026-10-25: two fixes from Codex's review of the graph tools at 0883d8ac

Codex's review of [pull request #207](https://github.com/melian-agent/melian/pull/207), the graph tools for the design lens, found two defects at 0883d8ac. Each has its own commit and a test that failed at that head first.

- a3525a39 (formatted in efab7676): a file-set search marked a file binary when its one matching line passed the byte bound. The cut output dropped the partial record, and the empty-pattern probe was cut too. The probe now asks git for the file's name alone, and the tool says the matches' lines are too long to show. The tests hold a matching line at the byte bound and one byte past it.
- 938d93ef: `graph_impact` kept whichever callers came first in Enola's JSONL when it reached its 200-node cap. Incoming edges are now sorted by file, line, name, id and kind, each once, so permuted facts give the same walk. A continuation past the cap is a new mechanism, left to [issue #219](https://github.com/melian-agent/melian/issues/219).

All 41 mutants of the fix commits were run by hand: 40 killed, 1 equivalent. The equivalent forces the binary probe for a file with matches; a file `git grep -I` matched is text, so the probe never marks it binary.
