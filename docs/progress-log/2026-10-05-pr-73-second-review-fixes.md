# Ledger second review fixes

[Pull request #73](https://github.com/melian-agent/melian/pull/73) now neutralises `www.` autolinks after an escaped marker, and sets the recovery status only when a provider refuses the ledger on purpose, through core's `LedgerRefusal`. A transient failure in a ledger write leaves the verdict's status alone.

Ledger recovery without a recorded ID follows `ours()`: the signature proves a comment is Melian's, and a known login only skips strangers early. A resolved reply an older Melian posted counts as already addressed. Run details are written in the commit that records the verdict.

A failed walkthrough stops after two attempts until `--rerun`. The stored ledger history keeps the newest 50 rounds. `LedgerStamp` folded into `Ledger.readStamp`. Tests cover each, plus a hand-deleted ledger and the walkthrough budget.
