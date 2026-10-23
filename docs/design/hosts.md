# Hosts

### Skills

Thin wrappers for Claude Code, Codex, and Pi that invoke the CLI and relay findings. They never run a review with the host agent's model. The Pi skill is a Pi package; the Pi extension adds a `/melian` command over the same CLI.

Built so far: one `SKILL.md` per host under `skills/`, each telling the agent when to ask Melian for a review, to run `melian review` on the branch or on a pull request, to relay the terminal rendering verbatim, to fix nothing it was not asked to fix, to publish only on the user's say-so, and to run `melian dismiss` only when the user tells it to dismiss a finding, giving the user's reason. `melian doctor` is the only command a skill runs without a trigger, and the only one Claude Code's skill pre-approves. A skill runs only the `melian` on the user's path. It never builds, installs, or runs Melian from the checkout, because the checkout is what Melian reviews and must not supply its reviewer; without `melian` on the path it tells the user to install it from a source they trust and stops. `melian doctor` names the executable that ran and warns when it lies inside the checkout. The repository installs its own Claude Code skill as `.claude/skills/melian/SKILL.md`, a checked-in copy of `skills/claude-code/SKILL.md` that a test keeps identical, so the agent writing Melian asks Melian for review. A symlink would be simpler, but git writes one as a text file where symlinks are off, and the skill would not load. [docs/guidelines/cli.md](../guidelines/cli.md#skills) says how to install each.

### Server and devcontainer

A long-lived process receiving webhooks, with one SQLite storage per changeset on disk, many changesets reviewed concurrently. The natural home for Pi Durable.

### GitHub Actions

Ephemeral runners make durability the feature rather than a nicety. Untrusted head code never runs with secrets; the `pull_request_target` footgun is avoided by never executing head code in the privileged job.

**The common case needs nothing special.** A push triggers the job, it restores the state branch, runs the pipeline, pushes state, and posts the review within its timeout. Most runs end here.

**Continuation when a review outruns the job.** The harness is given a budget a few minutes short of the job timeout. At the deadline it stops dispatching tasks, lets in-flight tasks reach their next checkpoint, pushes state, and dispatches a continuation of the same workflow through `workflow_dispatch` with the changeset ID as input. The continuation restores and resumes: finished lenses are not re-run, and the interrupted one resumes from its last checkpoint. `workflow_dispatch` is chosen over `repository_dispatch` because it targets one named workflow with typed inputs rather than a repository-wide event; the token permissions are the same either way, since the state branch already needs `contents: write`. The job token needs `contents: write`, `pull-requests: write`, `checks: write`, and `actions: write`.

**Recovery when a job dies.** A runner failure, eviction, or cancellation kills the job before it can dispatch a continuation. State up to the last checkpoint survives on the branch. Two things recover it, neither costing anything while idle:

- The next push on the pull request starts a normal run, which resumes rather than restarts.
- A small recovery workflow listens on `workflow_run` for the review workflow completing with a cancelled, failed, or timed-out conclusion. It reads the state index, and if the changeset is still marked in progress it dispatches a continuation. This catches runner death within a minute and runs only when a review run ends badly.

**The state index.** Every job maintains one small file on the state branch at each checkpoint, with one record per in-progress changeset: changeset ID, revision, the run ID working on it, a heartbeat, an attempt count, and an optional earliest-resume time. The recovery workflow reads it through the contents API in one request, never a checkout.

**Loop guard.** A continuation that fails the same way every time would dispatch forever. The attempt count caps continuations per revision at three. Past the cap, the check is set to not reviewed with the last error. A new push resets the count.

**Concurrency.** A `concurrency` group keyed by changeset, without cancel-in-progress, queues a comment-triggered job behind a running review. The durable submission admits the comment exactly once when the queued job runs. The group also makes a double dispatch harmless, and gives each changeset's storage the single writer Pi Durable requires.

**Waits and garbage collection are not automated.** A lens that hits a rate limit sleeps if the wait fits the remaining budget. If it does not, the job checkpoints with an earliest-resume time and stops; the next push, a comment command, or `melian review` resumes it. State for a closed or merged pull request is disposed by the `pull_request` closed event. There is no scheduled job.

**Completing the manifest from local records.** Problem: a maintainer who reviewed a pull request locally with every lens would pay again when Actions reviews it. Solution: the Actions host relies on local review records. `melian publish` pushes the changeset's storage, with its sightings, verdicts, and check records and their lineage, to the state branch. The Actions host opens it, runs only the checks the tier names that lack a record for the run identity, and publishes. The manifest already has the shape: a check with no record is not reviewed, so Actions completes the manifest.

A local record counts only when the push came from an identity with write permission on the repository while [writers are trusted](../design.md#writers-are-trusted), and its lens version, tool versions, and policy hash match the run identity. A pull request from anyone without write permission never relies on a local record: the Actions host runs the full gate for it. The model is lineage, shown in the ledger, not identity. Every record carries lineage: host, actor, Melian version, lens and tool versions, model, credential name, snapshot IDs, and timestamps. The single-writer rule holds through the concurrency group plus a lease check on push, so a local publish during a running Action waits. Whether a range review can seed a pull-request review is a separate [open question](../design.md#open-questions).

**Credentials on Actions.** The secrets file arrives in one repository secret, and the preferences file in a repository variable, which stays readable where a secret does not; each is optional. Subscription credentials work through the credential pool, and their terms are the user's contract with the provider. GitHub masks a secret's whole value but not its substrings, so at startup Melian registers every credential value with the `add-mask` workflow command, and the pool never puts a value in a message. A GitHub App with the secrets permission rotates OAuth credentials.

**A scheduled sweep is designed but not shipped.** A periodic workflow could read the index and recover changesets the event path missed, honour earliest-resume times, reconcile dangling check runs, and delete expired state. It would cost runner minutes on every tick to cover a rare case, so it is deliberately not enabled. The index carries what it would need, so it can be added without changing the state format if the event path proves insufficient. Two GitHub constraints apply if it is: scheduled workflows run only from the default branch, and GitHub disables them after sixty days of repository inactivity.

### Slack and others (later)

Another trigger adapter and publisher over the same pipeline.

### Other git providers (later)

The changeset abstraction already hides where a change came from. The provider-specific surface is small and known: fetching the change, posting the review and threads, receiving comment commands, and setting check status. All of it lives in `packages/github` behind a provider port defined in core. GitHub is the only implementation until a real user asks for another; a second provider is then a new package, not a refactor. Building GitLab or Bitbucket speculatively would contradict the minimal-core rule.
