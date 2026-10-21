# Builders can enumerate the mutants their tests must kill

Added `scripts/enumerate-mutants.mjs`, backed by the installed Stryker instrumenter. It reads committed ranges through `Changeset.resolve` and `Revision.diffLines()`, shares static.mutation's path exclusions, and includes JavaScript for repository scripts. Output defaults to 200 rows with an omitted count; JSON includes Stryker's ignored status and reason. Instrumentation runs in an empty scratch directory because Stryker's JavaScript parser otherwise loads the checkout's Babel configuration.

AGENTS.md now lists eight recurring survivor classes and requires an enumerated inventory. Builders classify every mutant, run all new-test and equivalence probes, and sample at least one in five existing-kill claims. The host mutation check remains the authority.

Tests began against a stub. A throwing Babel configuration then failed the CLI test before isolation and passed afterwards. Fixture output is compared with a direct instrumenter call. Tests cover unchanged lines, excluded paths, committed source, ignored metadata, exact output, argument failures and limit boundaries.

The final 15 tests pass. The script enumerated 156 mutants on its own change. All 119 manual probes ran: 113 failed tests and six survived with equivalence reasons. The other 37 carry named test claims. An extra end-bound probe passed the first fixture; adding an unchanged line immediately after the change killed it. Removing the help return and changing the default limit to 201 also failed tests. Scratch names include the creator's pid so cleanup assertions do not count another gate's directories.

The whole gate has not passed in the Codex sandbox. The repeated full run had 13 failed tests, 5,413 passed and 94 skipped, plus a hook timeout. Three failures say `ps failed: undefined`: the recorded-pid test and both real mutation backend tests. The runner termination test reports `toolFailed` rather than `invalidOutput`. The remaining failures include timeouts and a decision-read assertion following a timed-out mock. A further whole run and exact-head CI will be recorded before delivery. No tests or checks were disabled.

The full inventory, each failed test and equivalence probe, gate logs and script output live in `/Users/tal/dev/Melian/tmp/m2/scratch-mutant/mutant-checklist-report.md`. The host mutation check and model reviews remain with the coordinator; the brief permits no live model calls.
