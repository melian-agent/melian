# Step 11: opt-in Enola check

Built `static.enola`, pinned provisioning, base-policy copying, disabled providers, scratch output and HOME, snapshot lineage, and Enola policy-change notices. Fake scripts prove base/head subtraction and closed failures for exit 2 and 3. The default tiers still omit Enola. Melian's own fast tier opts in. The graph cache and coverage spike remain in progress.

Fix pass: the fake analyser now requires base constraint, intent and suppression contents in both runs, and rejects head-only policy files. Removing the copy loop fails the test instead of leaving the verdict boundary untested.
