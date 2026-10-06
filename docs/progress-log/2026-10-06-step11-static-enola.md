# Step 11: opt-in Enola check

Built `static.enola`, pinned provisioning, base-policy copying, disabled providers, scratch output and HOME, snapshot lineage, and Enola policy-change notices. Fake scripts prove base/head subtraction and closed failures for exit 2 and 3. The default tiers still omit Enola. Melian's own fast tier opts in. The graph cache and coverage spike remain in progress.

Fix pass: the fake analyser now requires base constraint, intent and suppression contents in both runs, and rejects head-only policy files. Removing the copy loop fails the test instead of leaving the verdict boundary untested.

Fix pass: runStaticTool API documentation now distinguishes Biome and tsc dependency sourcing from Enola’s manifest cache, and states the base-policy rule and disabled providers.

Fix pass: cleanup attempts base and head worktree removal independently and removes scratch in finally. It still reports the first execution error after all cleanup attempts. An injected timeout proves the second removal runs and scratch disappears.

Type checking caught a missing Error.name on the injected timeout fixture. The fixture now supplies the full ExecutionError shape; its cleanup assertions still pass.
