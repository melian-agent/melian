# Melian design

This document records how Melian works and why. It is the source of truth for architecture decisions. The [README](../README.md) describes what Melian does at the capability level; this document describes how.

Status: design phase, October 2026. Nothing here is implemented yet. Sections marked *open* are not yet decided.

## Goals

- Review every change before it merges, with static analysis and adversarial agentic review, against standards the team controls.
- Explain each finding in plain language: what, why here, what to do.
- Be durable. A review survives crashes, restarts, and deploys without repeating work or duplicating output.
- Be quiet. Good changes pass without ceremony. Findings are in scope, confident, and never repeated once dismissed.
- Bring your own models. Subscriptions and API keys, stacked and routed per role, including open-weight models.
- Remember, in the repository. Knowledge goes to the standard files by pull request.
- Run anywhere: locally, from a coding agent, in a persistent container, in GitHub Actions and equivalents.
- Be configurable per repository and per folder, for large multi-service monorepos.

## Non-goals

- Replacing human judgement. Melian never merges and never fixes without being asked.
- A hosted service. Melian is software you run.
- Forking Pi. Melian extends Pi Durable through its public extension points.
- A general chat interface over the codebase.

## Principles

Melian follows Pi's philosophy: a minimal core, extensible by design, small enough to be understood in full. Concretely:

- **One core, many hosts.** Review logic is written once. Where it runs is an adapter.
- **Advisory models, deterministic policy.** Models produce signals: findings, severities, probabilities. Whether a merge is blocked is decided by configuration, never by a model.
- **Data, not instructions.** Submitted code and comments enter prompts as quoted data. Only repository collaborators can command Melian.
- **Everything is a file in the repository.** Standards, lenses, configuration, and knowledge are versioned, reviewed, and inherited like code.
- **Replay-safe by default.** Every step either reruns safely or is guarded by an idempotency key.

## Concepts

| Term | Meaning |
|---|---|
| Changeset | The unit under review: staged changes, a branch range, a working tree, or a pull request. Everything downstream is identical regardless of kind. |
| Revision | One version of a changeset, identified by its head commit. A pull request has many revisions. |
| Check | A named unit of work that produces findings: a static tool run, a deterministic policy, or a lens. |
| Tier | A named set of checks, such as `fast`, `standard`, `full`. |
| Stage | A point in a workflow, such as `pre-commit`, `pre-push`, `pull-request`, `comment`, mapped to a tier. |
| Lens | An agentic check: a prompt, a tool policy, and routing, run as its own conversation with a specific focus. |
| Guardrail | A deterministic policy evaluated without a model: path rules, forbidden patterns, required files. |
| Standards | The natural-language conventions Melian reads: `AGENTS.md`, `CLAUDE.md`, and the Melian standards directory. |
| Finding | One objection, with a stable identity, a cause, a severity, evidence, an explanation, and a status. |
| Resolution | What a finding at a given severity requires before merge: `block`, `acknowledge`, `advisory`, `silent`. |
| Knowledge | A fact learned during review that should outlive the review. |
| Decision | A typed answer with a calibrated probability, from a decision model. |

## Architecture

### Three layers

```
┌─────────────────────────────────────────────────────────┐
│ Hosts: cli │ skills (claude-code, codex, pi) │ server │ actions │ slack (later)
├─────────────────────────────────────────────────────────┤
│ Pipeline: review orchestration as Pi Durable tasks and conversations
├─────────────────────────────────────────────────────────┤
│ Core: findings, lenses, checks, config, standards, knowledge, decisions, github, git
└─────────────────────────────────────────────────────────┘
```

**Core** is harness-free TypeScript. It imports pi-ai types and nothing else from Pi. It holds the finding schema and stable IDs, finding diffing across revisions, guardrail evaluation, static tool runners and SARIF normalisation, lens loading, configuration layering, standards and knowledge loaders, the decision-model port, and the GitHub and git clients. All of it is unit-testable without a harness.

**Pipeline** is the only place review flow lives. It is written once against Pi Durable: tasks, child conversations, documents, memos, hooks. Every host embeds this layer; none reimplements it.

**Hosts** adapt triggers, storage, credentials, execution environment, and time budget. The CLI is the primary host. The skills for Claude Code, Codex, and Pi invoke the CLI and relay its output; they never run a review with the host agent's own model. The server host receives webhooks and runs a long-lived harness. The Actions host is ephemeral and self-rescheduling.

Why the split: Pi has two extension systems. The coding agent uses `ExtensionAPI` (`pi.on()`, `pi.registerTool()`). Pi Durable uses `defineExtension()`, `defineTask()`, `hook()`. They do not interoperate. Writing orchestration against Pi Durable and keeping the local Pi extension thin avoids maintaining the review flow twice.

### The pipeline

Each step is a Pi Durable task. Each task checkpoints before moving on. Replay policy is noted per step.

1. **Intake.** Resolve the changeset to a revision: base, head, diff, metadata, and the layered configuration for every touched path. Replay safe.
2. **Triage.** One decision-model call over the diff summary: is this docs-only, generated, a dependency bump, test-only; which lenses apply; what is the risk score. Output selects the effective tier. Replay safe.
3. **Static analysis.** Run configured tools on base and head inside the execution environment. Diff the SARIF results to separate introduced from pre-existing. Replay safe.
4. **Guardrails.** Evaluate deterministic policies. Replay safe.
5. **Lenses.** Spawn one child conversation per selected lens, in parallel, each with its own model, instructions, and read-only tools. Each lens reports findings through a tool call, never through prose. Replay safe per lens; a crashed lens reruns from its last checkpoint.
6. **Adjudication.** Dedupe across lenses. Classify each finding's cause. Score severity and confidence through the decision model. Apply thresholds: drop, accept, or escalate to an LLM verification pass. Apply per-path resolution. Diff against the previous revision's findings: new, still open, resolved, dismissed. Replay safe.
7. **Publish.** Post the review, inline comments, and check status. Not replay safe. Guarded by memos keyed on revision and finding ID so a crash between posting and checkpointing cannot double-post.
8. **Knowledge.** Propose write-backs. Open or update the knowledge pull request. Not replay safe; memo-guarded like publish.

Only the publish and knowledge tasks hold write credentials. Lenses never see them.

### Mapping onto Pi Durable

| Melian | Pi Durable |
|---|---|
| A changeset's review history | One conversation, keyed by repository and changeset identity, persisted by ID across restarts |
| A new revision, a comment, a command | A `submit()` into that conversation; comments while busy use `whenBusy: "steer"` |
| A pipeline step | A `defineTask()` with phases and checkpoints |
| A lens | A child conversation via the subagent pattern, configured with `configure()` |
| Findings, triage decisions, knowledge proposals | `defineDoc()` documents, rewindable, committed atomically with the transcript |
| Standards and lens bodies | `section()` prompt sections rebuilt from files before every request, so edits take effect immediately and the transcript records what the model saw |
| Idempotent publication | `api.memo()` with first-write-wins semantics |
| Webhook delivery deduplication | `requestId` on submission, exactly-once |
| Tool restriction and command guardrails | `hook(ToolTask)` with `beforeTool` |
| Storage | The `Storage` interface: one atomic `commit(writes)` plus reads |
| Where tools run | The `ExecutionEnv` interface: a `FileSystem` plus a `Shell` |

Pi Durable is pinned to an exact version and wrapped behind one internal module, because its API is declared experimental. Churn upstream should land in one file.

## Findings

### Schema

A finding is a SARIF `result` plus Melian extension properties. SARIF because semgrep, gitleaks, and eslint emit it natively, GitHub code scanning ingests it, and it forces a stable schema from the first commit. Extensions:

- `id`: stable hash of file, rule, and a normalised snippet. Survives line shifts. Used for cross-revision diffing and dismissal matching.
- `cause`: `introduced`, `affected`, or `pre-existing`. See below.
- `trigger`: the diff hunk that caused the finding.
- `severity`: the repository's rubric, default `P0` to `P3` plus `nit`.
- `confidence`: calibrated probability that the finding is real.
- `resolution`: what this finding requires, after per-path configuration is applied.
- `status`: `new`, `open`, `resolved`, `dismissed`, `stale`.
- `explanation`: what, why here, what to do. Written for the author.
- `source`: which check produced it, and the lens or question-set version.

### Out-of-diff findings

Problem: a change inside the diff can break code outside it, and a lens reading outside the diff will also notice unrelated problems. Treating both the same either misses real breakage or turns every review into an audit.

Example: a pull request renames a function parameter. A caller in another file now passes the wrong argument. Meanwhile, that other file also has an unrelated SQL injection that predates the pull request.

Solution: classify by cause, not location.

- `introduced`: inside the diff. In scope, can block.
- `affected`: outside the diff, provably caused by it. In scope, can block. The lens must cite the specific code the change breaks.
- `pre-existing`: outside the diff, not caused by it. Never blocks. Appears once in a capped "noticed" section, is recorded in Melian's store, and is never raised again on that repository.

Static analysis gets the same split for free by running on base and head and diffing results.

### Cross-revision diffing

Each revision's findings are diffed against the previous revision's by `id`. New findings are posted. Still-open findings are not reposted. Resolved findings get a short resolution note on their thread. Dismissed findings stay dismissed unless the triggering hunk changes materially.

Local findings persist in the clone's `.git/melian/` directory, uncommitted. When a pull request opens, the server or Actions host imports them so the author is not told the same thing twice.

## Lenses

A lens is a directory containing `LENS.md`, modelled on the Agent Skills layout but deliberately not a `SKILL.md`, so that Claude Code, Codex, and Pi never load a lens as a host skill.

```text
.melian/lenses/security/
├── LENS.md
├── references/      # checklists the lens may read
├── examples/        # few-shot findings
└── tests/           # golden changesets with expected findings
```

```markdown
---
name: security
description: Injection, authz, secrets, unsafe deserialisation, SSRF, crypto misuse.
tier: heavy
tools: [read, grep, find]
severities: [P0, P1, P2]
paths: ["**"]
budget: { findings: 8, tokens: 200k }
extends: ~
standards: true
---
You are the security reviewer. Every finding must be caused by or provably
affected by the changeset. Read callers and config to confirm, never to audit.
Report through the finding tool.
```

Front matter is routing; the body is the system prompt for the lens's child conversation.

- `tier` names a model tier, never a model ID. Tiers resolve through model routing, which is overridable per path.
- `tools` is a read-only allowlist by default. The hook layer enforces it.
- `severities` bounds what the lens may report. The hook layer rejects findings outside it.
- `extends` lets a repository override parts of a built-in lens, such as its tier or an appended paragraph, without copying the body.
- `standards: true` injects the shared standards section. Default true; opt out for lenses where conventions are noise.

Layering follows Pi's resource rules. Built-in lenses ship inside the Melian package. Repository lenses live under `.melian/lenses/`. Folder-level configuration can disable a lens, change its tier, narrow its paths, or add one. Lens packs for a language or framework ship as Pi packages with a `melian.lenses` manifest key mirroring `pi.skills`, pinned in project settings.

Findings leave a lens through a `report_finding` tool with a TypeBox schema. Prose is never parsed for findings.

What stays out of a lens: topology, concurrency, deadlines, publication, and verdict rules. Those are tiers and resolution configuration.

## Checks, tiers, and stages

Checks are named. Tiers are named sets of checks. Stages map workflow points to tiers.

```yaml
tiers:
  fast: [guardrails, static, decisions.fast]
  standard: [fast, lens.correctness]
  full: [standard, lens.security, lens.contracts, lens.conventions]
stages:
  pre-commit: fast
  pre-push: standard
  pull-request: full
  comment: standard
```

Melian exposes `melian run <tier>` and `melian run --stage <name>`. It never installs git hooks. Recipes ship for lefthook, pre-commit, husky, and Pi.

The fast tier must finish in seconds. It runs guardrails, static tools, and decision-model questions such as "does this diff disable a test", "does this change a public contract", "does this touch auth or billing". No LLM runs in the fast tier.

## Configuration and layering

Problem: a multi-service monorepo needs different scrutiny for a payments service than for its docs, and a single root configuration cannot express that without becoming a rules engine.

Solution: `melian.yaml` may exist at any folder level. For a touched path, the nearest file applies, merged upward to the root, in the way `CODEOWNERS` resolves. Every setting layers this way: checks, tiers, stages, lens routing, model routing, resolution levels, write-back permission, decision thresholds.

The root `.melian/` directory holds what is not per-path: lenses, standards, knowledge, and lens-pack settings.

Resolution levels map severity to requirement:

```yaml
resolution:
  P0: block
  P1: block
  P2: acknowledge   # author must reply or dismiss with a reason
  P3: advisory
  nit: silent
```

A maintainer comment can override a block. Deterministic guardrails may block at any severity. Agentic findings block only when their confidence clears the configured threshold.

## Standards and knowledge

### Reading

Melian reads `AGENTS.md`, `CLAUDE.md`, and `.melian/standards/*.md`, nearest-first for the touched paths, and renders them as a prompt section into every lens that has not opted out. Changes to these files take effect on the next request.

### Writing back

Knowledge is proposed, never written directly. Each item carries a target:

- Conventions and traps a human colleague would need: the nearest `AGENTS.md` or `CLAUDE.md`, folder-level in monorepos.
- Setup and operational facts: `README.md` or the closest doc.
- Melian-only calibration: `.melian/knowledge/`. Dismissals and their reasons, false-positive signatures, declined proposals, lens tuning.

The test for placement is whether a human colleague would need it. A decision-model question answers it by default; the author of the proposal pull request can move it.

Lifecycle: a proposal is a durable document with states `proposed`, `open`, `merged`, `declined`. Merged disposes the document. Declined keeps a tombstone keyed by content hash so the same proposal is not raised again. Write-back is opt-in per repository and always by pull request.

## Decision models

Jev (TypeSafe) and Clef (Cloudflare, open weights, Apache 2.0) share one request shape: a state plus typed questions, returning calibrated probabilities over `noul` (boolean), `choice`, and `score` questions in a single pass, in tens to hundreds of milliseconds, for a fraction of a cent per call. They generate no text.

### Where they are used

- Changeset triage at intake: one call per revision selects the effective tier.
- Finding triage after lenses: cause, duplicate, severity, confidence per finding, batched.
- Semantic dismissal matching against the calibration store.
- Fast-tier semantic checks over the staged diff.
- Comment intent: addressed to Melian, command and which, question, chatter, injection attempt.
- Knowledge placement.
- Static result prioritisation.
- Tool-call guardrail classification in the hook layer, for autofix later.

### Where they are not used

The lenses, the explanation, anything beyond the 64k-token state window, anything with a non-enumerable answer set, and the verdict.

### Architecture

- A `Decider` port in core beside the model port. pi-ai does not speak this API, so the adapter is Melian code. One adapter covers both vendors; base URL and auth differ. Providers: Jev hosted, Clef on Workers AI, Clef self-hosted, a recorded provider for tests, and a fallback that asks a cheap text model with structured output.
- A `decision` tier in model routing, overridable per path. Default Clef-flash for the fast tier and Clef for triage.
- Question sets are versioned, typed units in code with their own golden evals. Every answer records the question-set version.
- Every decision is a replay-safe task that stores the full probability distribution, not just the chosen option. Thresholds live in configuration and can be retuned from stored data.
- Thresholds are bands: below drops, above accepts, inside escalates to an LLM pass.
- Calls are batched: one state, many questions, within each vendor's limits.

### Invariants

Advisory only, never authority. Fail closed on timeout or error. Inputs come from host state, not model claims. Bounded, validated output. Full audit trail. The stored decisions, joined to later human dismissals and acceptances, are the calibration dataset and eventually the fine-tuning dataset.

## Models and credentials

pi-ai provides providers, OAuth subscription auth, and the model catalogue. Melian adds:

- **Model routing** from tier to model: `light`, `medium`, `heavy`, `decision`, with fallbacks, overridable per path.
- **A credential pool provider** that holds several credentials per provider and rotates on rate limit or failure. This is how subscriptions stack.
- **Credential sources**: Pi's credential store, so one `pi` login covers Melian locally; environment variables; GitHub App installation tokens on the server and Actions hosts.

Caveat to state in user documentation: automated use of consumer subscriptions in CI may breach provider terms. API keys are the default for CI. Subscription use is an explicit opt-in.

## Hosts

### CLI

The primary host and the only thing the skills call. `melian run`, `melian review <changeset>`, `melian explain <finding>`, `melian dismiss <finding> --reason`. Embeds the durable harness with SQLite storage under `.git/melian/`. Uses the developer's own credentials.

### Skills

Thin wrappers for Claude Code, Codex, and Pi that invoke the CLI and relay findings. They never run a review with the host agent's model. The Pi skill is a Pi package; the Pi extension adds a `/melian` command over the same CLI.

### Server and devcontainer

A long-lived harness receiving webhooks, SQLite on disk, many changesets reviewed concurrently. The natural home for Pi Durable and the first host after the CLI.

### GitHub Actions

Ephemeral runners make durability the feature rather than a nicety. Each job restores state, works until done or until its time budget runs out, checkpoints, and re-dispatches itself. State lives in the state branch by default. Untrusted head code never runs with secrets; the `pull_request_target` footgun is avoided by never executing head code in the privileged job.

### Slack and others (later)

Another trigger adapter and publisher over the same pipeline.

## State storage

Pi Durable's `Storage` interface is one atomic `commit(writes)` plus reads. The shipped JSONL backend writes an append-only `main.jsonl` with sidecars over a `FileSystem` abstraction.

The orphan-branch backend, the default for Actions, is JSONL storage on a worktree of a `melian/state` branch. Each durable commit becomes a git commit and push. `--force-with-lease` is the compare-and-swap that keeps concurrent runners honest. Per-changeset subdirectories avoid conflicts and make disposal on close a directory delete. Push latency of about a second is acceptable against reviews that take minutes.

Alternative backends behind the same interface: SQLite in the Actions cache, object storage, Postgres, Cloudflare Durable Objects.

## Trust and isolation

Existing code on the base branch is trusted. Submitted changes and comments are not.

- Read-only analysis of the head is fine anywhere.
- Anything that executes head code runs in a sandbox with no secrets. That includes static tools that load repository-controlled plugins, such as eslint configurations.
- Comment commands require write permission on the repository. Comment bodies enter prompts as quoted data behind an injection guard section.
- Lenses are read-only in version one and never hold write credentials.
- The `ExecutionEnv` interface, a `FileSystem` plus a `Shell`, is the seam for a container-backed environment. Pi's own repository carries Anthropic's sandbox-runtime as a development dependency; it is a candidate for local isolation.

Version one on a developer's own machine reviews the developer's own code and needs none of this.

## Interaction model

On a pull request, Melian posts one review per revision with inline comments, a summary, and a check status derived from resolution. In threads it takes commands from collaborators:

- re-review, optionally a tier or a path
- explain this finding
- dismiss this finding, with a reason
- focus on a path for the rest of this review
- remember this

Each command is a submission into the changeset's conversation. Commands arriving mid-review steer it rather than restarting it. Dismissal with a reason is the most valuable input: it feeds the calibration store and the decision-model dataset.

## Evals and testing

Noise is where every reviewer fails, and the only defence is measurement. The evals package is first-class:

- A corpus of golden changesets with seeded defects and expected findings.
- Recorded model and decision responses for deterministic unit tests.
- Live runs scored on precision and recall per lens and per question set.
- Calibration measurement for decision models before any threshold default is trusted.
- Lens tests travel with the lens directory.

Unit tests use Vitest and Pi Durable's memory storage.

## Tech stack

Match Pi's conventions unless there is a reason not to.

| Concern | Choice |
|---|---|
| Runtime | Node 22.19 or later, ESM only, TypeScript |
| Repository | npm workspaces, Biome, esbuild for the CLI bundle, Vitest |
| Schemas | TypeBox, pinned to pi-durable's version; JSON Schema derived for editor validation |
| Config | YAML for `melian.yaml`, Markdown with front matter for lenses and standards |
| Findings | SARIF plus extension properties |
| Models | pi-ai, with the credential-pool provider |
| Decisions | Melian `Decider` port; Jev and Clef adapters |
| Durability | pi-durable, exact-pinned, wrapped behind one module |
| Storage | memory for tests, SQLite locally and on the server, JSONL on the state branch for Actions |
| Execution | Node environment locally, container environment for untrusted code |
| GitHub | Octokit, GitHub App auth on server and Actions, `gh` token locally; git by shelling out |
| Telemetry | pi-telemetry over OpenTelemetry |

## Package layout

```text
packages/
  core/          harness-free domain
  pipeline/      Pi Durable orchestration
  github/        Octokit client, review publication, state branch helpers
  state-git/     orphan-branch storage backend
  decisions/     Decider port and adapters
  cli/           the melian command
  pi-extension/  /melian command and Pi package manifest
  evals/         golden corpus and scoring
skills/
  claude-code/
  codex/
  pi/
lenses/          built-in lenses
docs/
```

## Roadmap

**Version one.** The CLI, the skills for Claude Code, Codex, and Pi, built-in lenses, guardrails, static analysis with SARIF, decision-model triage, findings persistence under `.git/melian/`, and the evals package. Runs on a developer's machine or in a devcontainer against trusted code.

**Fast follow.** The GitHub Actions host with the state-branch backend, pull request publication, comment commands, and knowledge write-back by pull request.

**Then.** The server host, Slack, container isolation for untrusted code, autofix beginning with suggestion blocks, decision-model fine-tuning from calibration data.

## Decision log

| Decision | Choice | Why |
|---|---|---|
| Base | Pi Durable, extended not forked | Durable tasks, documents, memos, child conversations, and pluggable storage map directly onto review needs |
| Two extension APIs | Orchestration against Pi Durable only; local Pi extension stays thin | Avoids maintaining review flow twice |
| Skills | Invoke the CLI only, no host-model mode | One review path, multi-model and durability preserved |
| Tests | Vitest | Pi itself uses it; better ergonomics than node --test |
| Lens format | One `LENS.md` with front matter per directory, not `SKILL.md` | The Pi way for Markdown units; avoids hosts loading lenses as skills |
| Findings | SARIF plus extensions, stable IDs, cause classification | Native tool support, GitHub ingestion, stable schema |
| Out-of-diff | Introduced and affected can block; pre-existing never does and is raised once | Keeps reviews in scope without missing breakage |
| Hooks | Named tiers and configurable stages; Melian never installs hooks | Workflow is the repository's business |
| Knowledge placement | Standard files first; Melian store only for Melian-specific calibration | Knowledge should be inherited by humans and every agent, not one tool |
| Resolution | Per-path severity-to-resolution map; models advise, config decides | Monorepo scrutiny varies; blocking must be deterministic |
| State | Pluggable; orphan branch default for Actions | No third-party dependency for review history |
| Trust | Base trusted; head and comments untrusted | Matches the actual threat |
| Write-back | Always by pull request; Melian copy disposed on merge; tombstone on decline | Reviewed like code; no re-proposals |
| Decision models | Advisory signals into deterministic policy; stored distributions; banded thresholds | Cheap, fast, calibrated; never authority |
| License | MIT, same as Pi | Alignment with Pi and Earendil |

## Open questions

- Whether the fast tier's decision-model questions ship enabled by default, given they require a configured decision provider.
- The exact per-vendor batching strategy for finding triage, given Jev's 32k-token per-question limit.
- Whether lens packs are discovered from `.agents/`-style locations as well as `.melian/lenses/`.
- How the Actions host re-dispatches itself with the least permission: `workflow_dispatch`, a repository dispatch event, or a scheduled sweep.
- Whether the server host should also accept GitLab and Bitbucket webhooks in the first iteration, or whether the git provider abstraction waits.
