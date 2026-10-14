# A candidate rule: an instruction names an input the request never supplies

Problem: a change can tell a model to use something the request built for that model does not contain. The instruction is a string and the request is an object built elsewhere, so nothing in the diff shows the two meeting, and no lens owns the gap.

Example: on [pull request #116](https://github.com/melian-agent/melian/pull/116), the verifier's instruction said to "pass lower with the severity one step down", but the claim the code built for it carried no severity. A verifier that guessed wrong forfeited the lowering. The Opus review of record found it by capturing the verifier's first request on the fake model; twelve Melian rounds did not. [The record's section on C1](../../packages/evals/comparisons/2026-10-14-pr-116.md#c1-which-lens-owns-a-defect-that-only-a-live-run-or-a-prompt-read-reveals) walks the lenses: `contracts` queries callers, and an instruction string has none; `design` has no rule for an instruction that depends on an input; `tests` saw scripted tests that cannot see what a model was shown; `correctness` reads code paths, not prompt text. It was adjudicated `no-owner`.

Choice: `contracts` owns the class, as a candidate rule `instruction-input-unsupplied`. A prompt and the code that builds its request are a contract between two parts of one change, the same shape as a caller and a callee. The rule reports a changed instruction that names a field, value or section the request builder for that prompt does not supply, or a changed request builder that stops supplying one an unchanged instruction names. The finding cites the instruction's line and the builder's.

`tests` keeps its own part: a test of a prompt change renders the first request on the fake model and asserts that every input the instruction names is present. That is the "fake answers only what the request asks" instance in `AGENTS.md`, applied to what the request carries.

It stays a candidate until a second pull request shows the shape, as the record proposed and as `AGENTS.md` asks before a finding becomes a check. The plan step that adds it waits on that second instance or on the [review outcome task](2026-10-15-review-outcome-task.md) reporting one.

What this gives up: the rule asks `contracts` to read prompt text as an interface, which costs tokens on every change that touches a lens, a verifier instruction or a request builder. A builder that assembles its request across several files may be out of the lens's reach at its level's reading scope, and then the rule says less than it seems to.
