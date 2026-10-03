# Melian decision log

One row per decision that shaped Melian, newest last. [design.md](design.md) explains each decision in full; this table records what was chosen and why, in the order it was chosen. Rows are appended, never edited in place. A reversed or changed decision gets a new row that names the row it replaces.

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
| Fast-tier decisions | Enabled by default; degrade silently to guardrails and static when no provider is configured | Semantic pre-commit checks are the point; the tier must never wait on an LLM |
| Decision batching | Vendor limits as capability descriptors; generic packer; hash-dedupe then choice over candidates | Limits change per vendor and over time; code should not |
| Lens locations | `.melian/lenses/` canonical, `.agents/lenses/` also discovered, nearest-first | Mirrors Pi's dual discovery; `LENS.md` is invisible to skill loaders |
| Actions continuation | `workflow_dispatch` with changeset input; `workflow_run` recovery workflow; state index with attempt cap; no scheduled sweep | Event-driven recovery costs nothing idle; a sweep burns minutes for a rare case and can be added later without changing state |
| Git providers | GitHub only behind a provider port in core | Second provider is a package, not a refactor; nothing speculative |
| Conversation keying | One storage per changeset; Melian maps changeset to storage | Pi mints conversation IDs; matches per-changeset state layout; one writer per changeset |
| Publication idempotency | Durable published document plus marker check, not memos | Memos are task-scoped and temporary |
| Policy and standards source | Read from a git revision chosen by the host: base for pull requests, worktree for maintainer local runs | A head must not rewrite the policy or prompts of its own review |
| Repository content bounds | Typed errors over size limits, no silent truncation | Unbounded reads are a resource hazard from untrusted input |
| Severity rubric | Fixed `P0` to `P3` plus `nit` in version one; custom rubrics deferred | A closed set lets configuration be validated and resolution stay deterministic; nobody has asked for another |
| Finding triggers | A hunk carries its file and a stable index within it | A finding can name the hunk that caused it without copying it |
| `.melian/` placement | Any folder level for standards and lenses, nearest-first; knowledge and lens-pack settings at the root only | Per-path content layers like `melian.yaml`; repository-wide state has one home |
| Finding identity | file, rule, normalised snippet, and occurrence ordinal | Identical snippets in one file must not collide; line shifts must not change the ID |
| Cause by location | Location proves introduced only; affected needs lens evidence; pre-existing otherwise | A location heuristic must never make an old defect block |
| Lens-reported findings | Lens supplies location, rule from its declared list, severity, explanation, evidence; Melian derives snippet from the head revision and everything else | Identity must not depend on the model's wording |
| Findings ownership | The changeset's root conversation, never a lens's child conversation | A fork of the root at any revision must carry the findings; a lens conversation ends with its task |
| Resolution ownership | Only adjudication writes resolution; tools store none | A tool must not decide what blocks |
| Review attachment | One lens task per head, and one adjudication task per head and input, recorded in a root index; a repeat call attaches, never duplicates, and an adjudication the index no longer names records no verdict | A crash must not double the model spend, nor let an older verdict overwrite a newer one |
| Prompt boundaries | Head content only inside nonce-delimited labelled boundaries, with an injection policy section first in every lens | Content must be data, never instructions |
| Evidence for affected | A changed-code location overlapping a hunk, snippet derived from head | Prose cannot cross the cause boundary |
| Finding sightings | Immutable per head, lens, and ID; adjudication merges deterministically | No first-writer-wins across lenses or pushes |
| Check manifest | The tier's check list is the review manifest; a check with no record is skipped and the verdict is not-reviewed | A verdict must never read passed because something was not counted |
| Dedupe and lifecycle | Only same-status findings merge; a dismissal never absorbs an open blocker | A dismissed advisory must not hide a live P0 |
| Review identity | Base plus head, in the index, the tasks, the verdict, and the sightings | A retargeted pull request has a new diff and the same head |
