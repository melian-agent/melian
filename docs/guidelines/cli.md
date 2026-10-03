# CLI guidelines

The cli package is the `melian` command. It is the primary host and the only thing the skills call, so every Melian capability must be reachable from it. It chooses what the domain leaves to a host: which revision policy comes from, where storage lives, which models run, and how the outcome reaches a shell. Review logic stays in core and the pipeline.

## Commands

| Command | Does | Exits |
|---|---|---|
| `melian review <range\|#pr> [--rerun]` | Reviews a range of the checkout, or fetches a pull request and reviews it, then prints the verdict's terminal rendering. `--rerun` runs again the lenses that failed in the last review of the same base and head | `0` passed, `1` findings with one blocking, `2` not reviewed, `3` findings with none blocking |
| `melian publish <#pr>` | Posts the stored review of the pull request's current head to GitHub | `0` published, `1` refused or failed |
| `melian findings <range\|#pr> [--open] [--json]` | Prints the stored verdict, or with `--open` the findings that still need attention, as text or JSON | `0`, or `1` when nothing is stored |
| `melian doctor` | Checks Node, git and `--attr-source`, Pi's login, which providers have credentials, the GitHub token's source, gh, the repository, and which tiers `melian.yaml` routes to a model, warning when it routes none | `0`, or `1` when Node or git cannot run a review |

A command line Melian cannot read exits `64`. A review that fails before it has a verdict, such as on a `melian.yaml` that does not parse, exits `2`: nothing was reviewed. `--model provider/id` routes every tier `melian.yaml` leaves unrouted, as `MELIAN_EVAL_MODEL` does for live evals.

A pull request is `#` and its number. Quote it, `melian review '#12'`: an unquoted `#` starts a comment in bash and in zsh scripts, which leaves `review` with no argument. A bare number is not accepted, because `1234` is also an abbreviated commit hash.

## Where policy comes from

- A pull request reads `melian.yaml`, standards, and lenses from the base commit GitHub reports, so the head cannot rewrite its own review.
- A range whose head is the checked-out commit reads them from the working tree: its author is the one running Melian, and an uncommitted `melian.yaml` edit should apply.
- Any other range reads them from its base.

The lenses always read the head commit, never the working tree.

## Pull requests

`review '#12'` reads the pull request through the provider, fetches `refs/pull/12/head` and the base branch from `origin` into `refs/melian/pull/12/head` and `refs/melian/pull/12/base`, points both at the commits the provider reported, and reviews `refs/melian/pull/12/base...refs/melian/pull/12/head`. The changeset's ID hashes those ref names, so every push to the pull request is a new revision of one changeset with one storage file, and the findings document can tell new from still open from resolved.

A review is keyed by its base and head, the merge base and the head commit, so `findings` and `publish` read the verdict stored under both. `publish '#12'` reads the pull request again, fetches its base branch, and computes the merge base it diffs from now. It refuses when the head or that base differs from the stored review's, naming which, with a message to run `review` again: a pull request retargeted to `main` after its parent merged keeps its head, but GitHub now shows another diff. It opens storage with only the publish task installed, so a review a crash interrupted does not resume and spend tokens during a publish. It never posts a review of a range or a working tree: storage for a range is a different changeset, and `publishReview` refuses a base and head with no stored verdict. `findings '#12'` reads the local refs and storage only, with no network.

## Checks Melian does not run yet

The tier `melian.yaml` maps the `pull-request` stage to is the review's manifest, and every check in it needs a record, as [the pipeline guideline](pipeline.md#the-manifest) describes. The default tiers name `guardrails` and `static`, which Melian does not run until step 6. The CLI records each check of the manifest that is neither a lens nor a decision as `skipped`, with the reason `Melian does not run this check yet`, so a review reads not reviewed and exits `2`. A repository that accepts reviews without them says so in `melian.yaml`:

```yaml
checks:
  allowSkip: [guardrails, static]
```

A repeat `review` of the same base and head attaches to the last review's finished lens task and prints the failure it stored, so it spends no tokens unasked. `--rerun` runs the failed lenses again, after a rate limit or an outage.

`origin` must name the GitHub repository. The token comes from `GITHUB_TOKEN`, then `GH_TOKEN`, then `gh auth token`; Melian prints where it came from, never the token.

## Storage

Each changeset has one SQLite file, `melian/<changeset-id>.sqlite` in the clone's common git directory, which is `.git/` in an ordinary clone and is shared by every worktree. Pi Durable allows one process per storage, so two `melian` commands on one changeset at once is unsupported.

## Scripted mode

`MELIAN_TEST_SCRIPT=<script.json>` runs every tier on the fake model, answering each lens from a script in a golden's `script.json` shape, through `scriptLenses` from `@melian-agent/pipeline/testing`. It exists so the gate can run the built binary end to end without a provider. Storage moves under `melian/scripted/`, and `publish` refuses to run, so nothing a script produced can reach a pull request.

## The binary

`bin/melian.js` is committed, executable, and imports `dist/bin.js`. npm links a package's bin only when the target exists at install time, and `npm ci` runs before any build; a bin pointing into `dist/` was never linked, and `npx melian` then asked the registry for a package named `melian` instead. Build with `npm run build`, then run `npx melian` from the repository.

Node 22 prints `ExperimentalWarning: SQLite is an experimental feature` on every run that opens storage, and a test that expects an empty stderr fails on Node 22 alone. `src/warnings.ts`, imported first by `src/bin.ts`, drops that one warning and passes every other to Node's own printer. Keep it the first import: ES modules evaluate in import order, and the warning fires as `node:sqlite` loads.

## Tests

`test/cli.test.ts` builds the CLI with `tsc -b` and runs `bin/melian.js` with plain Node against golden repositories from `@melian-agent/evals` in scripted mode. It checks exit codes, and that `review` prints exactly `renderFindingsTerminal` of the verdict `findings --json` reads back. Publication is tested in `packages/github` against a fake GitHub; nothing here calls the network.
