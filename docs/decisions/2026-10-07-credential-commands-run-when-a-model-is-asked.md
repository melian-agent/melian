# Credential commands run when a model is asked

Choice: A named credential's command runs when a review is about to start a task that may call a model, and not before. `reviewChangeset` calls the host's `unlockModels` once, ahead of the first lens, triage, or verification task it creates or resumes. A repeat review that attaches to finished tasks calls nothing and runs no command. Asking whether a provider holds credentials runs no command either: `hasCredentials` counts an unread command as present, as planning does.

The credential error still stops the review before the model is asked, naming the credential and its file. It no longer stops it before the review storage opens, since the review must read the storage to know whether it has tokens to spend.

Why: Problem: `melian review` ran every selected provider's command first, and the route check ran it again through pi-ai's `checkAuth`. A repeat review reads the stored verdict and spends nothing, yet it paid a password manager's prompt, or a fingerprint, for each run. Example: a command that asks for a fingerprint, and a second `melian review main` on a head already reviewed. Solution: decide from storage. A finished lens, decision, or verification task of the same selection is attached to without a model, so only a review that creates or resumes a task unlocks.

One limit remains. A task a crash left unfinished starts at the harness's first wait, ahead of the unlock, and reads its credential when it asks; a failing command then fails that lens rather than the review's start.

Supersedes: [2026-10-06-named-bearer-credentials.md](2026-10-06-named-bearer-credentials.md), only its timing: "Before opening durable review storage, Melian unlocks each selected command." The bearer cutoff, the precedence, and the rule that Pi's login never replaces the planned source stand.
