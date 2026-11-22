# The coordinator's standing authority to dismiss

Status: the maintainer ruled on 2026-10-17, in the coordinator's session: "yes take the authority and run these". The coordinator had proposed standing authority to dismiss equivalent mutants, each with a written reason no input can tell it apart, and to read policy notices on files it has read. He extended it on 2026-10-22, in the same session, to a static survivor that a named test kills by hand. On 2026-11-17, in the coordinator's session, he agreed to record it here, because a reviewer could not check a dismissal against a rule no file held.

## Problem

Coordinators dismissed findings under a ruling that lived only in a session. A reviewer reading a dismissal on a pull request had no rule to check it against.

## Decision

The coordinator may, without asking the maintainer:

1. Dismiss an equivalent mutant, with a written reason that no input can tell it apart from the original.
2. Dismiss a static survivor, one the mutation check says was reached outside any test, when a named test kills the exact mutation by hand. The reason carries the proof.
3. Read a policy notice on a file it has read.
4. Dismiss a finding that restates a ruling the maintainer already gave, citing that ruling's date and place.

Limits:

- Every dismissal carries a one-line reason and is listed in the coordinator's report to the maintainer.
- A dismissal is run under the round's own overrides, so the verdict's policy fingerprint matches.
- Dismissals post under the maintainer's login. The reason says "the coordinator, under the maintainer's standing authority of 2026-10-17", or cites the ruling.
- Any other blocking finding, and any acknowledge finding from a lens, needs the maintainer's own read or ruling, asked through the coordinator as [the questions decision](2026-11-17-questions-for-the-maintainer-go-through-the-coordinator.md) says.

## Why

Equivalent mutants and hand-killed survivors are a matter of fact the reason can show. A rule held in the repository lets a reviewer check each dismissal against it.
