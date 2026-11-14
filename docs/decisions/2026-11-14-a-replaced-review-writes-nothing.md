# A replaced review writes nothing

Amends: [Review attachment](2026-10-03-review-attachment.md), "an adjudication the index no longer names records no verdict", which now holds for every commit a review makes from a task's outcome
Amends: [Probe reruns: once a probe, conclusive runs only](2026-11-12-probe-reruns.md), its sentence that the verification after the reruns checks the lens selection, not the task
Amends: [A dismissal carries to a restatement](2026-11-08-dismissal-carries-to-restatement.md), the commit that re-derives a revision's inheritances, which a replaced review no longer makes

Status: the coordinator chose this approach on 2026-11-14 for [pull request #296](https://github.com/melian-agent/melian/pull/296). On 2026-11-13, in the builder's session, the maintainer ruled that #296 fixes only its own half, the probe reruns, and that the other half gets an issue of its own, [issue #381](https://github.com/melian-agent/melian/issues/381). The coordinator's reading, which this decision follows: that ruling permitted a follow-up and did not forbid fixing it here. The reason for deferring was that nothing worse than a redone verification could happen, and a test has shown that false. So building it now needs no new ruling. Nothing here is a new ruling of the maintainer's.

Problem: two reviews of one head can run at once, and the later can replace the earlier's lens task or verification task in the review index. Each commit that wrote from a task's outcome asked its own question about whether the earlier review still owned the entry: one compared lens selections, one the lens task, one the verification task, and several asked nothing. A review whose question missed the replacement went on writing over the later review's work.

Example: review A's lens task finishes, and review B replaces it with a new run of the same head. A's verifier starts late. At `10046215` A's verification replaced B's and cleared B's judgements, so B's verdict no longer blocked on the finding B's verifier had confirmed. Three more paths wrote the same way. A that read no candidates detached B's verification. A with no verifier reached the link commit and cleared B's restatement links. A sharing B's live lens task adjudicated from a verification B had since replaced under another key.

Choice: one predicate, `stillOwns` in `packages/pipeline/src/review-index.ts`, asks whether the index entry still names this review's lens task and, where the review relied on one, its verification task. Every commit that writes from a task's outcome calls it inside the commit, so no write can slip between the check and itself:

- starting the verification;
- detaching a verification when the review finds nothing to verify;
- recording the restatement links;
- starting the adjudication, with the verification it relied on;
- taking the probe reruns over;
- storing the caller record;
- opening the verification waves, and starting a wave.

A review that fails the predicate writes nothing and ends `superseded`, at the first such commit it reaches. The later review's verification, judgements, links and verdict stand.

A review whose reused wave another review's final verification retired ends `superseded` too. That other review shares the lens task and decides the claims the wave held. The earlier review used to adjudicate with its verifier marked failed, which put its `not reviewed` adjudication in the index over the other's.

What it gives up: a review that loses the entry this way records no verdict and pays for the work it did. A user sees `superseded` where a review a `--rerun` replaced used to end `lensFailed`, or where one whose wave was retired ended `verifierFailed`.
