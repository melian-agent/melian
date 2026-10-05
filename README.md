# Melian

Melian is an open-source, durable code review agent that keeps watch over your codebase.

It takes its name from Melian the Maia, queen of Doriath, whose Girdle held back every harm from the realm she guarded. Melian does the same work for your main branch.

## At a glance

- **Fast where it counts.** Decision models answer the yes-or-no questions of review in tens of milliseconds, so triage, severity scoring, and the pre-commit tier finish before you have finished reading the diff. Static analysis lenses give rapid, deterministic feedback with no model in the loop at all.
- **Deep where it matters.** Adversarial agentic lenses, each with its own focus and its own model, hunt for what would break: security holes, breaking changes, departures from your standards.
- **Your subscriptions, your cost.** No per-seat pricing and no model markup. Bring the subscriptions and API keys you already pay for, stack them, and route each job to the cheapest model that does it well.
- **Durable.** A review survives crashes, restarts, and deploys, and picks up where it left off without posting anything twice.
- **Quiet.** Good changes pass without ceremony. Findings stay in scope, and a dismissal with a reason is never raised again.
- **Remembers in your repository.** Acquired knowledge goes to `AGENTS.md` and its siblings, by pull request, where every person and every agent inherits it, not in propietary products to lock you in.
- **Runs anywhere you do.** Locally before a pull request exists, as a skill inside Claude Code, Codex, or Pi, on pull requests as a colleague, in a devcontainer, or in GitHub Actions.
- **Built for monorepos.** Every setting, from which lenses run to what blocks a merge, is configurable per folder.

## Why

Code review is where a main branch is defended, and the volume of change arriving at that gate is going up fast. Agents now write a large share of the code that teams merge, and a human reviewer cannot read every line with the care it deserves.

The commercial reviewers that have appeared to fill that gap share the same problems. They are slow: every pull request waits minutes for a full pass, regardless of how trivial the change is, and nothing runs before the pull request exists. They are expensive in a way that compounds: per-seat pricing on top of the model costs you are already paying elsewhere, or cost in time with harsh rate limits -- with no say in which model does the work. They lock you into their models and their pricing. Some are noisy, so teams learn to scroll past them. And they forget: every pull request starts from zero, or worse: whatever they learn about your codebase stays inside their service.

Melian is our answer. It is built in the open, on [Pi](https://github.com/earendil-works/pi), and it is designed to behave like a careful colleague rather than a linter with opinions. It spends milliseconds on the questions that need milliseconds and minutes only on the changes that deserve them, and it does so on subscriptions you already own.

## What it does

**Reads every change before it merges.** Melian combines static analysis tools with adversarial agentic review. The static tools catch what tools are good at. The agentic lenses are prompted to find what would break, not to summarise what changed.

**Checks changes against the guardrails your team has set.** Standards live in your repository, in the files your team already uses (`AGENTS.md`, `CLAUDE.md`, and friends) plus a small amount of Melian configuration. Melian reads them as the definition of acceptable, and objects to anything that would do damage: a security hole, a breaking change, or a quiet departure from the conventions you agreed on.

**Explains each objection in plain language.** Every finding says what is wrong, why it matters here, and what to do about it. The author should never have to guess what the reviewer meant.

**Survives crashes, restarts, and deploys.** A long review is durable. If the process dies halfway through, Melian picks up where it left off, without re-running what was already done and without posting the same comment twice.

**Lets good changes through without ceremony.** A docs-only change or a dependency bump should not trigger a five-minute review. Melian triages first and spends effort where the risk is.

**Remembers, in your repository.** When Melian learns something about your codebase, such as a convention, a trap, or a decision the team made in a review thread, it proposes writing it back to the standard place, by pull request. Knowledge that would help a human colleague goes to `AGENTS.md` and its siblings. Only knowledge that is specific to Melian itself goes into Melian's own store.

**Stays in scope, with care.** Findings must be caused by the change, or provably affected by it. Pre-existing problems Melian happens to notice are mentioned once, never block, and are never raised again.

## How you work with it

**Locally, before a pull request exists.** Melian ships as a command-line tool with named tiers of checks. A fast tier runs in seconds and suits a pre-commit hook. A standard tier suits pre-push. The full review suits a pull request. Which tier runs at which point in your workflow is yours to configure, with sensible defaults, and Melian never installs hooks for you.

**From your coding agent.** Melian is available as a skill for Claude Code, Codex, and Pi, so an agent that has just committed code can ask for a review before pushing it. The skill drives the same command-line tool, so you get the same review you would get anywhere else.

**On pull requests, as a colleague.** Melian posts a review, replies in threads, and takes instructions in comments: re-review, explain this finding, dismiss it with a reason, focus on a path, remember this for next time. A dismissal with a reason teaches it.

**Where you run it is up to you.** A persistent devcontainer or server, or GitHub Actions and equivalents. The review state lives where you choose, with a branch in your own repository as the default, so nothing about your review history depends on a third party.

**Later: Slack and other messaging, and automatic fixes.** Both are designed in from the start and arrive after the review itself is solid. Fixes begin as suggestions you can accept with one click.

## Bring your own models

Melian does not sell you model access. You bring your own subscriptions and API keys, stack several of them, and decide which model does which job: a strong model for the security lens, a cheap one for triage, a fast open-weight decision model for the yes-or-no questions that do not need a paragraph of reasoning. Routing is configurable per repository and per folder, so one monorepo can give its payments service more scrutiny than its docs.

## Built for large monorepos

Every setting Melian has, from which lenses run to what severity blocks a merge, can be overridden at the folder level. The nearest configuration wins and merges upward, in the same way `CODEOWNERS` works.

## Trust model

Code already on your main branch is trusted. Submitted changes and the comments on them are not. Melian will read a pull request with full attention and treat its contents as data, never as instructions, and anything that executes untrusted code runs isolated and without secrets.

## Built on Pi, in Pi's spirit

Melian is built on [Pi Durable](https://earendil.com/posts/pi-durable/), and extends Pi rather than forking it. We share Pi's philosophy: a minimal core, extensible by design, that you can make your own. Features that do not belong in the core become extensions, and the code should be small enough that a person, or an agent, can understand all of it.

We also share the values of [Earendil](https://earendil.com), who build Pi: craft and openness, and the belief that humans are the best agents, with tools that strengthen human agency rather than replace it. Melian never merges, never fixes without being asked, and always explains itself. The judgement stays with your team.

Melian is licensed under the MIT License, the same as Pi.

## Project status

Melian is in the design phase. The design document lives at [docs/design.md](docs/design.md) and is the place to read if you want to know how it works or to argue with a decision.

## Independence and sponsorship

Melian is an independent open-source project. Some of the work on it, including model tokens for development and evaluation, is sponsored by [me&u](https://meandu.com). The project is not owned by, tied to, or steered by any company.

## Contributing

Contributions are welcome once the foundations are in place. We will hold the same bar as Pi: you must understand the code you submit. Using an agent to write it is fine. Submitting what you cannot explain is not.

### Running Codex tasks

Codex's own sandbox denies writes under `.git`, so a Codex task cannot commit or fetch. `scripts/codex-sandboxed.sh` runs the task in full-access mode inside a narrower sandbox of our own. It works on macOS only.

```
scripts/codex-sandboxed.sh <worktree> <model> <prompt-file> [log] [scratch]
```

Run it from a linked worktree beside the checkout (`git worktree add`), as every Codex task here does. It exits 64 for the main checkout: the worktree allowance would cover `.git`, and a task could rename it and put its own in place.

Writes are allowed in:

- the worktree, the scratch directory, and a per-run directory the script creates under `$TMPDIR` and removes on exit. The task gets `TMPDIR` set to the per-run directory and its own npm cache at `<scratch>/npm-cache`, so `~/.npm` and `/private/tmp` stay closed. Scratch defaults to the per-run directory;
- in the common git directory, only `objects`, `refs`, `logs`, `packed-refs`, and `packed-refs.lock`;
- in the worktree's administrative directory (`.git/worktrees/<name>`), only the state files a commit, merge, or rebase writes (`HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `MERGE_HEAD`, `MERGE_MSG`, `MERGE_MODE`, `AUTO_MERGE`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `COMMIT_EDITMSG`, `index`, `gc.pid`, `shallow`, each with its `.lock`) and the `logs`, `rebase-merge`, and `rebase-apply` directories;
- in `~/.codex`, only `sessions`, `log`, `cache`, `tmp`, `ipc`, `thread-writer-locks`, `mcp-oauth-locks`, `attachments`, the `*.sqlite` databases, and a handful of state files such as `history.jsonl`. The script creates the directories before it starts. `shell_snapshots`, `memories`, and `.tmp` stay closed; this was not tried against a live Codex run, so if Codex needs one, add it to the profile and this list.

Writes are denied everywhere else, including the rest of the home directory and any other checkout. Further rules block what a task could use to run code outside the sandbox: `.git/hooks`, `.git/config`, `.git/config.lock`, `.git/info`, the administrative directory's `commondir`, `gitdir`, `locked`, and `config.worktree`, and the worktree's `.git` pointer file; and in `~/.codex`, `config.toml`, `auth.json`, and `hooks`. `commondir` and `gitdir` matter most: a task that could rewrite them could point git at a directory of its own holding a `core.fsmonitor` setting. `~/.config/gh` is read-only, since gh's keyring login needs no file writes.

Because `.git/config` stays closed, `git push -u`, `git branch -u`, and `git remote add` fail inside the task. Push without `-u`, and never set an upstream from inside the task. ssh remotes fail too, since `~/.ssh` is unreadable, and so do registry tokens in `~/.npmrc`; use https remotes and the keychain.

The sandbox confines writes, not secrets. Reads stay open except for `~/.ssh`, `~/.pi/agent/auth.json`, `~/.npmrc`, and any `.env` file at the root of the worktree and of the main checkout. `~/.codex/auth.json` stays readable because Codex needs it, so Codex must be logged in through it rather than an API key variable. gh's configuration, including `~/.config/gh/hosts.yml`, is readable and its keychain token usable, as git's osxkeychain credential is, so `gh pr create` works and the sandbox confines writes, not the user's GitHub identity. The keychain stays reachable because gh and git need it, other files in the home directory stay readable, and the network is open, so a task can still send what it can read to anywhere. The script removes the obvious secret variables from the task's environment (`GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `CLOUDFLARE_*`, and `*_API_KEY`) and keeps the rest, including `PATH`, `HOME`, and `TERM`. Codex's standard input is `/dev/null`, so `codex exec` never waits on it. Commit, fetch, `gh`, and npm installs work. The sandbox does not limit what a task pushes. The brief should tell it to push only its own branch.

`scripts/codex-sandboxed.sh --print-profile <worktree> [scratch]` prints the profile and exits without running Codex.
