# Credentials follow concrete task routes

A light triage route can choose a medium lens that reports no finding. Unlocking the entire plan first still asks for a deep credential and a verifier credential. Neither request will run.

Unlock each concrete task's route. Triage uses its chosen decider provider. Lens tasks use the routes selected after triage, including their stored escalation routes. Verification unlocks only after candidates exist. A walkthrough unlocks its light provider immediately before its task. The credential store caches commands, so repeated provider unlocks run no command twice.

Hosts also unlock the stored union of live model tasks before their first wait. A changed plan cannot replace that union. An attached live lens or verifier task does not unlock its full route again: the host already unlocked the providers its checkpoint can reach. Finished tasks need no unlock.

Supersedes: [2026-10-07-credential-commands-run-when-a-model-is-asked.md](2026-10-07-credential-commands-run-when-a-model-is-asked.md), only its once-per-review unlock of all possible providers. Task timing, errors and finished-task attachment rules stand.
