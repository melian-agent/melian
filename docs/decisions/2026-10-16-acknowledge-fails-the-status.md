# An unresolved acknowledge finding fails the published status

Choice, agreed by the maintainer on 2026-10-16: once `melian/review` is a required status on `main`, a finding that resolves `acknowledge` and has no dismissal fails the status, as a block does. A maintainer dismisses it, with a reason, to pass. This is plan step 28, "An unresolved acknowledge fails the status". Nothing is built yet; this file and `docs/design.md` record the rule.

## The problem

Today only a blocking finding maps the status to `failure`. An `acknowledge` finding is advice, whatever the table says: the design says an author "must reply or dismiss", and nothing checks that they did. [The as-built resolution decision](2026-10-13-resolution-as-built.md) says so about a pre-existing finding that a folder caps at `acknowledge`: "The step builds no gate of its own." Earlier text had believed it gated the merge, and that belief cost [pull request #117](https://github.com/melian-agent/melian/pull/117) rounds before it was corrected.

Example: a policy notice on a changed `melian.yaml` resolves `acknowledge`. Under a required status, the pull request still shows green, and merges, with the notice unanswered. The coordinator's queue rule already treats the same finding as a stop, so the status and the process disagree.

## What changes

- The published status maps to `failure` when the verdict has a blocking finding, or an `acknowledge` finding with no dismissal. A pre-existing finding that a folder opted into `acknowledge` is one of them.
- A dismissal with a reason, by a maintainer, clears one finding by its ID, as `melian dismiss` records it today. The findings document keeps the dismissal across revisions, so a carried finding that was answered stays answered.
- The status description counts blocks and unresolved acknowledgements apart.
- A policy-change notice resolves `acknowledge` at least, so every change to a `melian.yaml`, standards file or analyser configuration needs a dismissal on its pull request. That is the cost, and the maintainer accepted it.
- The coordinator's rule, "an acknowledge finding other than `policy-change-review` stops the queue", becomes the host's: the status now says what the rule said, and only a dismissal clears it.

## What already holds

Nothing of this holds. The code maps `findings` with a block to `failure` and every other `findings` verdict to `success`. Dismissal, its reason, and its persistence across revisions exist and are unchanged.

## What it changes in design.md

The pre-existing paragraph under "Resolution" drops "It sets no gate of its own" and the sentence after it, and the publication paragraph for the commit status states the new mapping. The decision about the pre-existing cap keeps every other clause.

## Open for the step

Who may dismiss on each host: the CLI publishes with the dismisser's own token, and the Actions host needs a writer check. The step settles it against the trust rules for the status, and writes the test that a non-writer's dismissal does not pass.

Amends one clause of [2026-10-13-resolution-as-built.md](2026-10-13-resolution-as-built.md), "The step builds no gate of its own". That decision stays active for everything else.
