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

## Exact rule for attacking review, phase 1

This section specifies step 28 before implementation. It does not describe built behaviour.

- Count the adjudicated `block` and `acknowledge` groups. Every member of `acknowledge` counts, including a pre-existing opt-in, whether new or carried. Dismissed findings are outside those groups. Members of "Pre-existing, important" lifted from `silent` to `advisory` do not count. The heading alone creates no acknowledgement requirement.
- A complete verdict of `findings` maps to `failure` if either group is non-empty. Its description is `N finding(s), B blocking, A unresolved acknowledgement(s)`, with ordinary singulars. For example, acknowledges alone give `1 finding, 0 blocking, 1 unresolved acknowledgement`. N is `verdict.counted().length`; B and A count their respective groups. Advisory-only success keeps `N finding(s), none blocking`; an empty counted set gives `Passed`. Dismissing every acknowledge therefore passes when no other finding requires failure. An incomplete review still maps to `error` first. Writer trust off still maps to the trusted-host `error`.
- `blocking` continues to mean a non-empty `block` group. An acknowledge does not become a block. The verdict remains `findings`, and `melian review` still exits `3` for acknowledges without blocks. Blocks still exit `1`, not reviewed `2`, and passed `0`. A successful `melian publish` still exits `0`, including when it publishes `failure`.
- The terminal keeps `Verdict: findings` without `blocking` for acknowledges alone. Both it and the GitHub review body add `melian/review: failure (1 finding, 0 blocking, 1 unresolved acknowledgement).` for that example. They also say `Dismiss unresolved acknowledgements with a reason, then publish.` while any remain. This line describes the verdict's mapping; publication still reports the trusted-host override when writer trust is off. The GitHub review event stays `COMMENT`. The existing groups, including the important pre-existing heading, keep their names.
- Policy notices have no exemption. An undismissed `acknowledge` notice on an `AGENTS.md` change fails the status. Reading the notice, replying on GitHub, or the coordinator allowing it does not clear it. A maintainer records a dismissal with a reason and publishes again. A policy notice that resolves `block` still fails as a block.
- Resuming a publication after upgrade uses this mapping, even if it planned its round before upgrade. The saved round keeps its verdict, finding IDs, fingerprint and round number. Its old computed success is not authority. The publisher maps the current stored verdict before posting, as today; a pending older verdict still posts as planned, followed by the current verdict when they differ. Signed posts already accepted are recovered without duplication. Completed old publications are not rewritten in the background; an explicit publish updates their status. Phase 2 must prove this with a fixture written by the preceding build and a reopen test.

Core trusts the lifecycle state it receives; it does not authenticate a dismissal's `by` text. On the CLI, a writer publishing local dismissals attests them. For a dismissal-bearing verdict that would publish `success`, require the publisher's current repository permission to be `write`, `maintain` or `admin`. An absent or lesser permission yields `error`, with `Not reviewed here: a repository writer must attest local dismissals`. A git author name is no proof. With writer trust off, the existing trusted-host error takes precedence. The Actions host must authorise its dismissal commands when that host is built; this step adds no comment command.

## What it changes in design.md

The pre-existing paragraph under "Resolution" drops "It sets no gate of its own" and the sentence after it, and the publication paragraph for the commit status states the new mapping. The decision about the pre-existing cap keeps every other clause.

## Dismissal authority

The phase 1 rule above settles CLI authority at publication, where GitHub supplies the publisher's permission. Phase 2 tests that a non-writer's local dismissal cannot publish success. The Actions host's command authorisation remains part of that host.

This file answers a question [2026-10-13-resolution-as-built.md](2026-10-13-resolution-as-built.md) left open: it says whether one should is "a question about `acknowledge` across the repository", "left to the readiness check". That decision stays active and does not conflict. Its words "no `acknowledge` finding fails the published status" describe the code today, which stays true until step 28 lands. Its "no gate of its own" stays true: a pre-existing finding gets the repository-wide gate and none beyond it. When step 28 lands, the sentence on the status stops describing the code, and the step writes the decision that supersedes the file and restates every clause that survives, since the log retires a superseded file whole.
