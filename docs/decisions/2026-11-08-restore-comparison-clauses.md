# Restore the comparison clauses that partial supersessions retired

Restores clauses for [2026-10-07-silent-reviewer-needs-a-trace.md](2026-10-07-silent-reviewer-needs-a-trace.md), [2026-10-05-comparison-sites.md](2026-10-05-comparison-sites.md), [2026-10-06-comparison-refuses-superseded-verdict.md](2026-10-06-comparison-refuses-superseded-verdict.md) and [2026-10-07-comparison-prints-not-writes.md](2026-10-07-comparison-prints-not-writes.md): the active decisions the partial `Supersedes:` chains below ended in. It declares no graph edge, so each of them can be superseded on its own.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

Where a clause below conflicts with any other active decision, including the ones named above, that decision wins. These clauses fill gaps the partial supersessions left; they override nothing.

[The review fixes](2026-10-05-comparison-review-fixes.md) superseded [the metrics decision](2026-10-05-comparison-metrics.md) for a few refinements. [The silent-reviewer decision](2026-10-07-silent-reviewer-needs-a-trace.md) then superseded the review fixes for one import rule. [The sites decision](2026-10-05-comparison-sites.md), [the superseded-verdict decision](2026-10-06-comparison-refuses-superseded-verdict.md) and [the prints-not-writes decision](2026-10-07-comparison-prints-not-writes.md) each superseded [the capability decision](2026-10-05-comparison-as-a-capability.md) for one part of it. The index retired each target whole. The clauses below still hold on main. This file restates them and changes nothing.

## From [2026-10-05-comparison-metrics.md](2026-10-05-comparison-metrics.md)

- Recall counts distinct valid groups. A reviewer gets credit only for its own report judged valid. Precision counts valid reports over valid, noise, and duplicate reports.
- An unadjudicated report is pending and enters neither metric.
- An external-only group whose valid reports all say `out-of-scope` stays outside Melian's recall denominator.
- An empty denominator gives 1, with the raw counts beside it. Reviewers aggregate by name and case-folded login, ignoring version.
- Earlier rounds stay in their statistics. A repeat on a second pull request is a candidate check. `melian compare stats` counts changesets as a stand-in, so two detached rounds of one pull request can still show as a candidate: a known gap, not policy.
- Withdrawing a finding leaves its history stored but removes it from that round's summaries.
- A group with conflicting miss reasons uses the first in-scope reason in site order, falling back to `out-of-scope`. Each defect contributes one miss. Titles that normalise to no letters or digits do not form repeat clusters.
- The drain counts each changeset once. At three or more comparisons, remaining debt keeps the drain due, including after a missed threshold. Local state cannot prove which backlog pull requests shipped or which live runs passed.
- The CLI does not claim that a `--golden none` acknowledgement verifies a shipped golden. An empty debt list owes no drain.
- The comparison adjudication class is named `Adjudication` in its module and exported as `ComparisonAdjudication`.

## From [2026-10-05-comparison-review-fixes.md](2026-10-05-comparison-review-fixes.md)

- Pending or ambiguous reports skip their reviewer's recall denominator in that group. An explicitly judged ambiguous report still enters precision.
- A valid external report without a miss reason becomes pending if its match disappears, and stats counts these reports separately.
- Replacement judgements preserve debt unless `--golden` changes it. Duplicates name another finding through `--of <id>` and cost their reviewer recall as well as precision.
- Metrics filters select whole changesets by first comparison time. Candidate checks, backlog, and drain use the whole clone. Candidates cluster valid external findings Melian missed; Melian's own findings remain available through the lower-level repeat query.
- Backlog takes the newest judgement of each finding across every round, even from a round that has since dropped the finding, so a golden discharged with `--golden none` stays discharged. A finding no round holds owes nothing.
- The export has no Fix commit column: the six columns are those the adjudication can fill.
- SQLite schema setup still requires writable storage, though stats, backlog, and export read without a harness or durable commit.
- Export reaches stored rounds without a current-head review, uses six-column tables with bounded first-paragraph summaries, prints author names without emails, and omits the drain notice.

## From [2026-10-05-comparison-as-a-capability.md](2026-10-05-comparison-as-a-capability.md)

- A comparison with external reviewers is a Melian capability, reached through `melian compare`, not a file an agent writes.
- An external finding has one shape. It names its reviewer, `codex`, `claude-code`, `coderabbit`, `copilot`, or `human`, with a version. It holds the file, line range, title, body, and the reviewer's severity. It keeps a stable source reference, the time posted, and whether its thread was resolved.
- A comparison holds, for one round, the external findings, Melian's, and the matches between them, in a document in the changeset's storage.
- Importers read a pull request's review threads through GitHub's GraphQL API, filtered by author login, with CodeRabbit's `coderabbitai[bot]` first. Others read a file: Codex's adversarial review JSON, or the external-finding shape for any other local reviewer.
- A `Decider` question may refine matching in milestone 4.
- `melian compare adjudicate` records valid, noise, or duplicate, a severity, and for a valid miss one reason: `owned-missed`, `no-owner`, `needs-execution`, or `out-of-scope`. It records too whether a golden is owed and for which lens, with the git author and time, as a dismissal is.
- `melian compare stats` gives recall and precision per reviewer, misses by reason, and repeat findings as candidate checks.
- `melian compare backlog` lists owed goldens, and `melian compare export` renders today's markdown record from the stored document.
- Every third comparison record is followed by a backlog pull request that ships at least two owed goldens, or every owed golden when fewer remain, and re-measures each new golden's lens with a live run of three passes, as the drain rule in docs/guidelines/evals.md sets out.
- A `needs-execution` miss is scope for the verifier, judged on whether it would have caught it, and for the tool manifest.
- In a customer's repository the comparison stays in the maintainer's clone, and only an explicit export writes it anywhere.
