# Direct adapter calls retain the fixed deadline

For [pull request #250](https://github.com/melian-agent/melian/pull/250), cap an explicit adapter deadline at the call’s own 120-second budget.
Earlier deadlines still apply. Non-finite supplied deadlines still fail before I/O.
The [clarification](../decisions/2026-11-04-direct-enumeration-deadline.md) records the existing rule for direct callers.

At base `482c21846262eaa51a636c4eb941962326e31493`, four request-aware cases froze monotonic time at 1000.
The at-bound and shorter-deadline cases passed. The one-past and far-future cases failed at the observed timeout assertion:
120001 and 9007199254739991 milliseconds, each expected to equal 120000.
After the fix all four pass. The existing exhausted, fractional, NaN and Infinity cases remain.

The complete production-delta inventory has two mutants, zero omitted. Each fails its named test when applied alone.
Three separate probes fail on removal of the cap, replacement of the shorter deadline, and removal of supplied-deadline validation.
The scratch runners restore source bytes in `finally` and record tuple hashes, source hashes, commands and actual results.
Evidence lives under `tmp/pr250-direct-deadline-fix/`, including the before/after logs and classified inventory.

The initial enumeration suite passed 160 tests and failed one existing sandbox-dependent Git initialisation under `node_modules`.
Leaving that test unchanged and excluding it from the focused run gives 338 passes across enumeration and CLI mutant suites, with one skipped.
Node 24.18.0, repository lint and type checking pass. Lint reports five existing informational notices.
The coordinator’s whole host gate, exact-head CI and final reviews remain pending; this executor did not run the whole gate.
