# Advisories go in the review body

Step 10. [Pull request #167](https://github.com/melian-agent/melian/pull/167), draft.
Implementation: `c8dff4a5`, `fix(github): keep advisories out of review threads`.

The rehearsal on [pull request #164](https://github.com/melian-agent/melian/pull/164) opened an advisory thread.
The required conversation rule made that advisory block the merge.
[The maintainer's decision](../decisions/2026-10-22-advisories-in-review-body.md) puts advisories in the body alone.

Each advisory now has a signed entry with an escaped file:line link to the head, its rule and a short summary.
The existing body limit bounds the list. Important pre-existing findings keep their label.
Acknowledge and block findings retain line placement.
A body finding that becomes actionable gets a thread when its lines permit one.
A finding lowered to advisory retires its old threads, including merged report threads.
An owed resolution survives later advisory heads and crash recovery.
No stored shape or dependency changed.

Six tests failed against the original sources for placement, promotion, owed retirement and rendering.
Two process-kill recovery cases also reproduced the stray advisory thread.
The GitHub package and core publication tests passed: 423 tests before the final mixed-provider assertion.
The SQLite regression kills publication after recording a lowering's review and before editing its old thread, then proves recovery closes it once.

The enumerator script is absent on the starting main. All 37 hand mutants were killed.
The provider's body-placement guard initially survived; a mixed review test now proves it avoids a rejected inline write and a second request.
The full inventory, replacements, failing output and passing output are in the builder's local report under `tmp/m2/scratch-advisories/` in the main checkout.

The whole gate ran: 5,477 tests passed, 53 skipped and four existing process tests failed under the Codex seatbelt's ps denial.
Biome, type checking, dependency checks and the audit gate passed.
A whole-gate rerun follows on the delivered head. The host must run the gate and automated mutation-only round outside the seatbelt.
The brief forbids live model calls, so model-backed review rounds remain with the coordinator.
The pull request stays draft and is not queued.

Fix pass 1, `ba54b332`: Codex's adversarial review found that crash recovery re-adopted an advisory thread the previous build had posted.
Recovery now keeps the advisory in the body and resolves its thread, as the plan does.
The regression resumes state recorded by main's publisher at `9923246b`, written by `write-advisory-crash-main.ts`.
Reconciling advisory threads recorded on earlier, completed verdicts is out of scope. The only such thread is the rehearsal's on [pull request #164](https://github.com/melian-agent/melian/pull/164), which is resolved and merged.
