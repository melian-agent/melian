A fix pass on [pull request #131](https://github.com/melian-agent/melian/pull/131) at a6643259 answered Codex's adversarial review and the review of record. Each item has a test that failed before its fix.

- A refuted sighting no longer wins its ID while another sighting stands, so the finding takes the standing sighting's severity and prose. The fix is c112b048, in `readFindings`.
- Two findings that any one check reported never merge, in either pass. The check that won the ID counts, and so does every check in its `reportedBy`.
- The snippet pass now orders by the severity the lens reported, so a lowering no longer regroups it.
- A dismissed hunk member stays in the speaker's listing.

Those three are in d53a85b2.

80a2ba3d changes what a dismissal reaches. The speaker's ID now dismisses only the reports the snippet pass merged with it. A report that joined through a hunk stays live, and `melian dismiss` lists it under "Still live, merged with it before:". The pre-upgrade dismissal test now runs on a verdict and an input that version 1 wrote.

The thread that F3 orphans predates the step and is left for an issue.
