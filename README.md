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
- **Built for monorepos.** Which lenses run, and what blocks a merge, is configurable per folder. A model route's `accept`, `unavailable`, and `acceptOverridden` are set once, in the root `melian.yaml`.

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

Melian does not sell you model access. You bring your own subscriptions and API keys, stack several of them, and decide which model does which job. A strong model takes the security lens, a cheap one triage, and a fast open-weight decision model the yes-or-no questions that do not need a paragraph of reasoning. Routing is configurable per repository, and a repository's `melian.yaml` may commit the team's default routes. A contributor without a route's credentials gets the same model from a provider they do hold, or the nearest by price, and every check run that way says so. Run `melian doctor` to see which model each tier would use, and from which credential.

### Your credentials

Melian reads credentials from two secrets files, then from Pi's login, then from each provider's environment variables:

- `melian.secrets.yaml` beside a repository's root `melian.yaml`, for one clone. Keep it out of git: Melian refuses one that git tracks.
- `secrets.yaml` in `~/.config/melian/`, or `$XDG_CONFIG_HOME/melian/`, for every repository you work on.

Each credential names a provider and takes its key from one of three sources:

```yaml
credentials:
  pinned-anthropic: { provider: anthropic, key: sk-ant-... }          # the key itself
  work-anthropic: { provider: anthropic, env: WORK_ANTHROPIC_KEY }    # an environment variable
  work-openai: { provider: openai, command: "op read op://dev/openai/key" }  # a command's output, user-level file only
```

A command runs only from your own `secrets.yaml` in `~/.config/melian/`, never from `melian.secrets.yaml`, which holds keys and environment variables only: a file inside a repository may have come from someone else's change. That file must be yours, with mode 600, in a directory no one else can write; otherwise Melian refuses the command. Melian never prints a credential.

Whether a subscription may be used in automation, or shared across a team, is a question for the provider's contract. Melian takes no position on it.

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

- the worktree, the scratch directory, and a per-run directory the script creates under `$TMPDIR` and removes on exit. The task gets `TMPDIR` and `TMPPREFIX` set to the per-run directory. zsh writes here-documents to `<run>/zsh`, and Codex runs every command as `zsh -lc`. The task also gets its own npm cache at `<scratch>/npm-cache`, so `~/.npm` and `/private/tmp` stay closed. Scratch defaults to the per-run directory;
- in the common git directory, only `objects`, `refs`, `logs`, `packed-refs`, `gc.pid`, `shallow`, and the `.lock` file of each of the last three. Git keeps `gc.pid` and `shallow` in the common directory even in a linked worktree;
- in the worktree's administrative directory (`.git/worktrees/<name>`), only:
  - the state files a commit, merge, or cherry-pick writes: `HEAD`, `ORIG_HEAD`, `FETCH_HEAD`, `MERGE_HEAD`, `MERGE_MSG`, `MERGE_MODE`, `AUTO_MERGE`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `SQUASH_MSG`, `COMMIT_EDITMSG`, and `index`, each with its `.lock`;
  - the `next-index-<pid>.lock` and `index.stash.<pid>` files that a partial commit and `git stash` write;
  - the `logs` and `sequencer` directories, so `git merge --squash` and a multi-commit `git cherry-pick` work.

  `rebase-merge` and `rebase-apply` stay closed. A task does not rebase, since its brief says to commit and push. Those directories hold a todo file with `exec` lines, which the host would run later with `git rebase --continue`, outside the sandbox;
- in `~/.codex` (or `$CODEX_HOME`, which must be absolute, when set; every rule below names that directory instead), only `sessions`, `log`, `cache`, `tmp`, `ipc`, `thread-writer-locks`, `mcp-oauth-locks`, `attachments`, `auth.json` and the `.tmp*` files beside it, the `*.sqlite` databases, and a handful of state files such as `history.jsonl`. The script creates the directories before it starts. `shell_snapshots`, `memories`, and `.tmp` stay closed; this was not tried against a live Codex run, so if Codex needs one, add it to the profile and this list.

Writes are denied everywhere else, including the rest of the home directory and any other checkout. Further rules block what a task could use to run code outside the sandbox. In the git directories, they close `.git/hooks`, `.git/config`, `.git/config.lock`, and `.git/info`. They also close the administrative directory's `commondir`, `gitdir`, `locked`, and `config.worktree`. In the worktree, they close the `.git` pointer file and any `.git` below the root. In `~/.codex`, they close `config.toml` and `hooks`. `commondir` and `gitdir` matter most. A task that could rewrite them could point git at a directory of its own holding a `core.fsmonitor` setting. `~/.config/gh` is read-only, since gh's keyring login needs no file writes.

Because `.git/config` stays closed, `git push -u`, `git branch -u`, and `git remote add` fail inside the task. Push without `-u`, and never set an upstream from inside the task. ssh remotes fail too, since `~/.ssh` is unreadable, and so do registry tokens in `~/.npmrc`; use https remotes and the keychain.

The sandbox confines writes, not secrets. Each point below is a limit or a rule of the read, network, and environment policy:

- Unreadable files: `~/.ssh`, `~/.pi/agent/auth.json`, `$PI_CODING_AGENT_DIR/auth.json` when set, `~/.npmrc`, and root `.env` files in the worktree and main checkout. Pi paths resolve symlinks; a configured path with a quote, backslash or newline makes startup exit 64. Startup also exits 64 if Pi's resolved agent directory lies inside any writable subtree. It must lie outside the worktree and scratch. `~/.codex/auth.json` stays readable and writable because Codex needs both, so Codex must be logged in through it rather than an API key variable. Other files in the home directory stay readable.
- Codex runtime paths and `auth.json` must stay under its home; directory entries cannot move or vanish, and symlink creation there is denied.
- The host’s Melian store under the common git directory and `<worktree>/.git/melian` is unreadable, protecting its ledger secret, reviews and dismissals.
- Root `.env` files in the worktree and main checkout cannot be written, moved, removed or created, so renames cannot bypass their read deny. Startup exits 64 if a root `.env` symlink targets a writable subtree: `.env` must be a regular file or absent.
- Credentials: gh's configuration, including `~/.config/gh/hosts.yml`, is readable. Its keychain token is usable, as git's osxkeychain credential is, so `gh pr create` works. The task acts with the user's GitHub identity. The sandbox does not limit what a task pushes, so the brief should tell it to push only its own branch.
- Mach services: the profile allows lookups of named services only, never launchd or LaunchServices, so a task cannot start a process outside the sandbox with `launchctl submit` or `open -a`. Five services were each proven necessary by running gh, git, npm, and node under the profile. `com.apple.SecurityServer` and `com.apple.securityd.xpc` serve the keychain. `com.apple.trustd` and `com.apple.trustd.agent` serve TLS trust. `com.apple.system.opendirectoryd.libinfo` serves user lookups. The rest come from Codex's own macOS profile, for Codex itself: directory and group lookups, logging, notifications, preferences, DNS and proxy configuration, certificate status, and power state.
- Network and sockets: the network is open over IP, so a task can send what it can read to anywhere. It cannot connect to a unix-domain socket other than the DNS resolver's (`/private/var/run/mDNSResponder`), so the launchd ssh agent and the Docker or Colima daemon are out of reach. The profile allows loopback servers.
- Environment: the script starts the task with an empty environment and passes through only `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG`, `LC_*`, `TZ`, `EDITOR`, `CODEX_*`, `GIT_AUTHOR_*`, and `GIT_COMMITTER_*`. It sets `TMPDIR`, `TMPPREFIX`, `npm_config_cache`, and `MELIAN_STATE_DIR` itself. Everything else is dropped, including `SSH_AUTH_SOCK`, `AWS_*`, tokens, secrets, passwords, `NPM_CONFIG_*`, `DATABASE_URL`, and `OPENAI_API_KEY`. Dropping `SSH_AUTH_SOCK` hides the variable, and the profile closes the socket. Codex's standard input is `/dev/null`, so `codex exec` never waits on it.
- Melian: `MELIAN_STATE_DIR` is where Melian stores its reviews. The script points it at `<scratch>/melian`, so a task's `melian review` writes to scratch and never to the clone's `.git/melian`, which holds the user's dismissals and ledger secret and stays closed. Melian's own `refs/melian/pull/<N>/head` ref is allowed, so scripted pull-request reviews can write that ref.
  A task can run Melian's tests and scripted reviews, with `MELIAN_STATE_DIR` keeping storage in scratch, but has no credential for a live review by design.
  A user-level `~/.config/melian/secrets.yaml` stays readable; a command credential there would let a task review on real models.
  The maintainer should not keep one if tasks must never spend tokens.
- Pushes: commit, fetch, `gh`, and npm installs work.

Limits the sandbox does not close:

- A task can write any file inside the worktree, so committed hooks, `package.json` scripts, `.husky`, `.gitmodules`, and `.lfsconfig` are untrusted until reviewed. Worktree and scratch roots cannot be renamed, removed or replaced; write allowances for them and the per-run directory cover children only. A task cannot create a symlink in the worktree outside `node_modules`, nor move or copy one in, so no path leads from the worktree to its temp directory. npm needs links under `node_modules/.bin`, so a symlink there is untrusted: the host must not enter one that a task wrote. The profile also refuses `chflags`, so a task cannot make a file immune to the wrapper's `rm -rf`. The task runs in its own process group, which the wrapper kills on exit, so a background child does not outlive it; a child that calls `setsid` escapes the group, yet it still cannot create a symlink or set a flag.
- Direct repository creation is denied in each persistent writable subtree: the worktree, a scratch directory apart from the per-run directory, `objects`, `refs`, `logs`, the administrative `logs` and `sequencer`, and the `~/.codex` subdirectories. The per-run directory is exempt: a task may create repositories under its temp directory, which the script deletes when the task ends, so `git init` in a `tmpdir()` directory works. A nested `config` could set `core.fsmonitor` or `core.hooksPath` and run when the host enters that directory, say through a symlink from the worktree. A `.git` component is denied in every subtree, in any letter case (`.GIT`), since APFS ignores case and git still finds the repository. Git never writes one.
- A task can rename a repository's parent from exempt temp storage into the worktree or scratch; [the decision](docs/decisions/2026-10-06-codex-sandbox-residual-limits.md) requires the host never run git inside directories a task created.
- A file named `HEAD` or `commondir`, in any letter case, is denied in every persistent writable subtree: the worktree, scratch, `objects`, `refs`, `logs`, the administrative `logs` and `sequencer`, and the `~/.codex` subdirectories. The per-run directory is exempt. Git takes a directory holding `HEAD`, `objects/`, and `refs/` as a repository. It also takes one holding `HEAD` and a `commondir` file that names a directory with those. The deny covers files and links; a directory named `head` or `commondir` is allowed. Git's own `HEAD` writes are allowed after the deny: `logs/HEAD` in the common and administrative directories, and `refs/remotes/<name>/HEAD` with its reflog, so `git remote set-head` works. A directory named `objects` directly under `refs/remotes/<name>` is denied, since the allowed `HEAD` there could otherwise start a repository. A remote-tracking branch named `<name>/objects/...` therefore cannot be created inside the sandbox. The worktree's own `HEAD` lives in the administrative directory, so commits are unaffected; a tool that writes a `HEAD` file inside the worktree fails. A ref whose last component is `head` in any case, such as the branch `feature/head` or the tag `head`, cannot be created, updated, or deleted inside the sandbox, because the same deny covers it. The one exception is `refs/melian/**/head`, which Melian writes for each pull-request review.
- Melian's `refs/melian/` tree and its reflogs deny `objects` and `config` components in any letter case. Both `logs` roots deny those names directly below them, as files or directories. These guards keep the allowed `head` and `logs/HEAD` files from completing a planted repository; git never writes those names there.
- Git's `sequencer/head` stays writable for a multi-commit cherry-pick, which also permits `sequencer/HEAD` on APFS. The sequencer denies `objects` and `refs` components, `commondir` files and nested `HEAD` files, so that allowance cannot complete a repository.
- `refs`, `logs`, and `objects` are writable and shared with every worktree, so a task can move or delete refs and objects: the sandbox confines code execution, not repository integrity.
- `~/.codex/cache` and `~/.codex/tmp` are writable because Codex needs them; whether Codex runs anything from them is unverified.
- A task can overwrite the user's Codex login, `~/.codex/auth.json`, and the temporary beside it that Codex renames over it. Codex rewrites that file itself when it refreshes a ChatGPT login, so the sandbox cannot close it.
- `.env` is unreadable only at the root of the worktree and of the checkout; a nested `.env` stays readable.

`scripts/codex-sandboxed.sh --print-profile <worktree> [scratch]` prints the profile and exits without running Codex.
