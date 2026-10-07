# The design lens chooses its baseline from active decisions at base

A mechanical base corpus resolves every Supersedes edge before the prompt cap. It marks predecessors inactive and names their successors. The prompt renders at most 100 entries, each at most 512 characters, and reports omissions. Incomplete reads, missing targets and cycles refuse the review. The rendered index joins the lens instructions and their fingerprint.

Base search uses the existing bounds, base attributes and untrusted boundaries. It discovers renamed terms and paths absent at head. The lens searches both revisions and reads active base text as evidence. A conflicting head decision without a Supersedes link is criterion-selection-bias.

Eighteen design goldens now cover eight of nine design rules, four new source-based clean twins, superseded-at-base behaviour and renamed terminology. Code and decision-file injection each have a case. Capability-by-class remains in the golden BACKLOG because the source decision names no finding to model.

The required live command exited 9 before starting an eval: /Users/tal/dev/Melian/.env was not found. No provider was called. Precision and recall for passes one, two and three, their means and their worst values remain unmeasured. No further live run was attempted. The lens remains in Melian’s full tier by the maintainer’s choice. Codex’s medium finding asked to remove it pending complete rule coverage and live measurement; [the superseding decision](../decisions/2026-10-08-design-lens-active-decisions-at-base.md) records both positions.

Commits: 45c1e47c adds the active-base corpus; aa65ff57 adds base search; 1bf0d941 adds baseline regression goldens; 3ef1ab75 adds owed rule cases and clean twins. The branch review fix, 0281b736, includes newline filenames and names the immutable factory load. The scope wording fix, c1f83350, aligns the final prompt instruction with active successors and pins version 100f4163cc7e. No comparison record changed. Only the authorised design-lens sub-bullet of the implementation plan changed.

Mutation inventory: 25 implementation cases failed when changed, including graph refusal, entry and row bounds, the decision read byte bound, instruction fingerprinting, search revision selection and its match bound, wrapping and newline discovery. One prompt-contract mutation, three scripted-report/tool mutations and 26 rule-fixture mutations also failed. The full inventory and logs are in tmp/design-lens-followup-report.md.

Validation: the full gate passed after both branch review fixes: 109 test files, 2,914 passing tests, 50 skipped and no vulnerabilities. It ran with MELIAN_STATE_DIR unset and four Vitest workers. All 55 distinct mutation cases failed as required. The missing live file and capability-by-class source are the remaining blockers.
