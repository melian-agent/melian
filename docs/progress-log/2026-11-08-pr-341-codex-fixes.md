# Pull request #341: Codex review fixes

[Pull request #341](https://github.com/melian-agent/melian/pull/341), for [issue #315](https://github.com/melian-agent/melian/issues/315), took two findings from Codex's adversarial review.

- `5deeb116` keeps a dismissal from carrying backwards. A review of an older head that resumed after a newer head's finding was dismissed could map the root's region backwards and inherit a ruling made later. `Predecessors.open` now keeps a root only when its revision's review began no later than the candidate's, by the order `recordRevision` keeps. A root on the candidate's own revision still counts, so the same-head case from [pull request #329](https://github.com/melian-agent/melian/pull/329) holds.
- `cd119b9a` lapses an inheritance when its root's severity is re-recorded. A repeated dismissal with the same dismisser, reason and content, but a new severity, kept the old `dismissedAt`, so a restatement linked under the old severity stayed dismissed past the severity fence. The repeat now takes its own time, which lapses the link until the next round derives it again.
