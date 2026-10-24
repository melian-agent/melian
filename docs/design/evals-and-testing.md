# Evals and testing

Noise is where every reviewer fails, and the only defence is measurement. The evals package is first-class:

- A corpus of golden changesets with seeded defects and expected findings.
- Recorded model and decision responses for deterministic unit tests.
- Live runs scored on precision and recall per lens and per question set.
- Calibration measurement for decision models before any threshold default is trusted.
- Lens tests travel with the lens directory.
- Comparison reviews: while Melian reviews its own pull requests, Claude Code's review skill and Codex's adversarial review run on the same pull requests as shadow reviewers. Every difference is adjudicated by a maintainer, as [Comparison with external reviewers](../design.md#comparison-with-external-reviewers) sets out. It becomes a golden, positive or negative, where the adjudication says one is owed. The shadows keep running until Melian reaches recall of at least 0.75 against the shadows' adjudicated findings. Use the ten most recent eligible merged pull requests after 2026-10-06T00:00:00Z. Every merged pull request in this repository after that instant is eligible, whether its comparison exists or not. A missing record or pending adjudication in that window blocks retirement. Require at least one adjudicated valid in-scope distinct shadow finding; zero findings leave recall undefined and keep both shadows running. Only the maintainer may tighten it. The window counts pull requests, not rounds. Integration with `melian compare stats` follows [pull request #72](https://github.com/melian-agent/melian/pull/72).
- Goldens from the records: each lens in the backlog ships with five goldens drawn from the comparison records, and the records' other differences are listed for scripted goldens. Every third comparison record is followed by a pull request that drains the backlog, as [the evals guideline](../guidelines/evals.md#comparisons) sets out.

The research behind a lens, a threshold, or a stance lives in [research/](../research/), one dated note per topic, so the evidence is reviewable beside the decision it supports.

Public benchmarks worth running against: Martian's Code Review Bench (MIT, offline golden comments plus an online developer-action signal), Qodo's injected-defect set, SWE-PRBench, and PRWeaver for multi-pull-request attack chains. None measures noise on clean pull requests, cross-revision behaviour, repository-specific standards, cause classification, or injection resistance; the Melian corpus covers those.

A repository built and reviewed entirely by agents, with every reviewer finding addressed by instruction, is a corpus of agent-written pull requests and a standards fixture, not a calibration source: acceptance there is compliance, not judgement. Human labels for calibration have to be produced deliberately.

Golden scoring reads merged adjudicated findings, excluding refuted and dismissed groups. Expectations match a file or alternative file and an eligible original rule/source pair. Refuted claims earn no credit, even when another claim keeps the defect live. The speaker’s original verdict governs its eligibility; the merged verdict may describe another claim. A second lens sighting of the same defect costs precision once. Scripted assertions check the matching claim’s original scenario and evidence.

`design-terminology-change` accepts the code file beside the decision file. A live check expected the omitting caller (`src/cli.ts:8`) as a second finding on the five writer-trust design goldens; neither Sol nor Opus reported it, so those goldens expect one finding.

Unit tests use Vitest and Pi Durable's memory storage. Repository-scale assertions read the commit under test; branch and history scenarios build their own fixture repositories. A mutation scratch repository carries the head’s reachable history without remote refs. Triage version fingerprints must match every earlier committed record. Missing or shallow history fails closed. [The history-test decision](../decisions/2026-10-12-triage-records-keep-reachable-history.md) records this constraint.

The built verifier corpus lives under `packages/evals/verifier/`, separate from lens goldens. Four execution-dependent misses must remain confirmed or plausible; two decoys must be refuted. The design supersession case must remain confirmed, with the base rule and decision index present in the judge’s instructions. Its scripted runner plants candidates through `report_finding` and exercises the durable verifier task. Live verifier evals remain opt-in and accept a separate model route. An unfinished judge scores its golden as an unjudged failure; the corpus continues.
