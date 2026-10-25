# Interaction model

Posting a review with inline comments, a summary, and a commit status was built in milestone 1, through `melian publish`. The ledger is built in milestone 2 (review of record), and the thread commands are planned for milestone 4 (comment commands).

On a pull request, Melian posts one review per revision with inline comments, a summary, and a check status derived from resolution and task state: passed, findings, or not reviewed. It keeps one ledger comment up to date across revisions. In threads it takes commands from collaborators:

- re-review, optionally a tier or a path
- explain this finding
- dismiss this finding, with a reason
- focus on a path for the rest of this review
- remember this

Each command is a submission into the changeset's conversation. Commands arriving mid-review steer it rather than restarting it. Dismissal with a reason is the most valuable input: it feeds the calibration store and the decision-model dataset. Learning from dismissals therefore leads milestone 4. A history source for lenses follows it: blame, and earlier review threads on the files a change touches.

### The ledger

Built in milestone 2.

Problem: a pull request shows Melian's findings but not what Melian did to reach them: which head a round reviewed, which lenses ran at which level on which model, what was refuted, and what was dismissed and why. A reader has to run the CLI to find out, and a review body per push scatters the answer across rounds. Editing the pull request description instead would race with its author and fight its template.

Solution: publication maintains one comment Melian owns per pull request, the ledger. The first publish creates it, and every later one edits it in place. Its comment ID is recorded in a changeset-level document, not the per-revision `published` document, because one comment spans every revision; a replay re-renders it rather than posting another. It carries a signed marker and a hidden, versioned JSON stamp with the base, head, round, verdict, counts, lens versions, plan fingerprint and projection fingerprint. The projection fingerprint hashes the exact final bounded visible body. Readback verifies both the stamp digest and that body. Its first visible line names the base, the head, and the round. Then, in order:

1. Open findings, the verdict and its published status mapping.
2. Override and not-reviewed warnings, uncollapsed.
3. A walkthrough, collapsed: a paragraph, a table of file or layer to summary, and a sequence diagram where one applies. The [summarise task](../design.md#the-pipeline) writes it on the `light` model tier, reading head content inside prompt boundaries and holding no write credentials, and publish renders it through the same escaping as findings. It is labelled a summary, never a verdict.
4. Run details, collapsed under the run's summary line: review time, tokens and their cache share, cost and each model with its reasoning level. Inside, the policy, the standards the review read, once, and a table with a row per stage from the review's stage telemetry: level, model, time, tokens, cost, outcome, and a budget only near or past its limit, as [the run details decision](../decisions/2026-10-25-run-details-from-telemetry.md) sets. A round without telemetry shows the plan: the manifest, models and levels, lineage, caps and the standards files each lens read. Both list each distinct lens note once with the lenses that carry it. The review body states only caveats, the notes that narrowed the whole review, as [the lens notes decision](../decisions/2026-10-25-lens-notes-leave-the-review-body.md) sets.

Neither the hidden stamp nor the run details carries `dismissal.by`: the dismisser Melian records is a git identity whose email does not belong on a pull request, as [the dismissal publication decision](../decisions/2026-10-04-dismissal-publication.md) says, and the dismissals section gives only each reason.
5. Verification outcomes.
6. Dismissals with their reasons.
7. One collapsed line per earlier round. Once a later round posts, stored history keeps only the base, head, round number and status.

`melian.yaml` switches the walkthrough:

```yaml
publish:
  walkthrough: { enabled: true, collapsed: true, diagrams: true }
```

`melian review` runs the summarise task only for pull-request targets, on the first credentialed model in the light route. It preloads bounded diffs and head content inside prompt boundaries. Its sole tool records the summary in storage; it has no repository write tools or publication credentials. An absent light route, missing credentials or a failed summariser leave a fixed visible note. A later review retries a failed summary, up to two finished or replaced attempts per revision. A pending indexed task resumes before the limit is checked and costs no attempt. `--rerun` resets the limit and also refreshes a successful summary. Provider details stay out of the comment. Publication never calls a model. `--no-walkthrough` skips summarisation during review or hides it during publish. Melian's own committed routes carry a light route, so its pull-request reviews run the walkthrough on that route's model at its committed level.

The walkthrough renders a paragraph and file table. A sequence diagram renders only participants and messages whose syntax and labels pass a small allowlist; other diagram text stays escaped prose. Run details include the manifest, lens versions, levels, routes, budgets, successful model usage and each lens's standards paths. The overall Standards line remains their union. Older records keep per-lens paths absent. The review plan records each lens's lineage when it left the committed route, and the run details render it; publication carries the plan's warning through the shared review-body renderer. The ledger summary also counts confirmed, plausible, refuted and unverified claims, including refuted defects that were not posted. Stage timings are read through `melian telemetry`; the ledger’s run details do not include them.

The walkthrough has its own size budget. It is shortened or dropped before dismissals, run details and the prompt. The body keeps its signed stamp when sections exceed GitHub's limit. Earlier rounds shrink to a line first; the oldest history sections are then omitted before current sections. The note points to the CLI. Whole sections are removed, so no details block or fence is left open.

The commit status is set before the review and ledger discovery, then updated with the ledger link. An abandoned round keeps that link. When a finding resolves, Melian edits its original inline comment to append the commit that addressed it, and resolves the thread, in place of the reply milestone 1 posts in the thread. A comment whose marker was removed is left as edited; its thread is still resolved and the action is recorded as null. `melian findings` and the ledger carry one fenced agent prompt listing every open finding, its ID, location, rule and dismissal command. It also gives the finding's explanation. No prompt fence is rendered when no finding is open. The block opens by saying that the finding text, paths, and code are untrusted review data. Melian never edits the pull request description; a one-line pointer there is optional.

VerdictDocument is version 13. Its migration reads versions 1 through 12 and preserves verification records, provenance and decisions. Version 8 added resolution decisions, version 9 provisional check records, version 10 protected-claim minima and diagnostics, version 11 each tier's reasoning level in the review plan, version 12 the override lineage for a changed level, and version 13 a check record's caveats. Version 1 keeps its head-only keys; no migration invents a base or makes those records publishable. Version 3 upgrades evidence, version 4 adds run details and walkthroughs, and version 5 separates fallback notes. [The merge decision](../decisions/2026-10-06-verifier-ledger-document-chain.md) records the compatibility rule.

The ledger is a projection of the durable store, never a source of truth. `melian findings --json` is the interface, and nothing parses the markdown. [The anatomy of CodeRabbit's output](../research/2026-10-04-review-output-anatomy.md) shows that a comment edited in place works, and that watchers break when its markup drifts; the stamp and the JSON interface avoid that.
