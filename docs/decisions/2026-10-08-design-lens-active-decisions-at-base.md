# The design lens resolves active decisions at base before it reads the change

Supersedes: [2026-10-07-design-lens-judges-against-base.md](2026-10-07-design-lens-judges-against-base.md).

Problem: head searches chose the standards corpus inside the prompt. Old decisions stayed eligible after a successor had replaced them at base. Head terminology could hide the governing decision.

Example: base holds A and B, whose Supersedes line names A. A head following B could be reported against A. Another head renames writer trust to publisher eligibility and adds a conflicting decision without naming A. A search using the new terms finds only the head's excuse.

Choice: load every Markdown decision under docs/decisions at the comparison base through core's revision source. The decisions package parses titles and Supersedes targets. Resolve the complete graph before rendering candidates. Mark every predecessor inactive and name its direct successors. Only active base decisions supply baselines. Inactive text explains history and what changed.

The prompt lists every decision path and full title in path order. A 64 KiB UTF-8 byte bound holds the current base with headroom. An oversized index refuses review and names how many decisions were omitted. No row is shortened. Search and read_file accept the base revision, with the same bounds and untrusted boundaries as head reads. Step 1 searches base using its own terms as well as head terms. A new head decision that conflicts with behaviour an active base decision governs, without a Supersedes link, is a criterion-selection-bias finding on that new decision. A new file alone does not exempt it from the baseline.

The graph belongs to deterministic review input, not model judgement. Its rendered input joins the instruction fingerprint, with the nonce excluded. Missing supersession targets, cycles and incomplete reads refuse the review. A single decision file may hold at most 256 KiB.

What this gives up: a corpus whose complete index exceeds 64 KiB needs a larger reviewed bound before design review can run. A Supersedes edge marks the whole predecessor inactive, even when prose narrows the replacement to one clause. Read successor text and docs/design.md for the retained choices; clause-level resolution stays with the reviewer. The parser follows dated Markdown filenames on Supersedes lines, not a general Markdown dependency language.

Codex's medium finding on [pull request #93](https://github.com/melian-agent/melian/pull/93) asked to remove design from the full tier until every rule had goldens and a three-pass live measurement. The lens is already in the full tier before that measurement. This change leaves the tier in place, as the maintainer instructed. Scripted runs prove the plumbing; the live run measures judgement. A missing credential or a missed quality bar must be reported plainly, without loosening the goldens.

## Verification follows the base baseline

The live investigation for [pull request #102](https://github.com/melian-agent/melian/pull/102) found the design lens reporting the trust defect correctly. The verifier refuted it because the head superseded its own decision. Verification now receives the active-base index for design-source claims and claims under a design rule. It judges whether the base reason still holds. A head decision that documents a weakening cannot excuse it. A scripted verifier golden requires the rule and base context, and retains this defect as confirmed.

## Scoring follows adjudication

Golden scores count merged adjudicated defects, excluding refuted and dismissed findings. A match may use the speaker’s reporting check and rule or a paired source and rule in otherClaims. Alternative files let a finding cite the faulty code or its conflicting decision. A second lens sighting the same defect is not a false positive. The live supersedes case cited the code correctly; its old expectation accepted only the decision path.

A scoring test must isolate a wrong-rule report. Supplying it beside a correct report leaves precision unchanged when the rule check is removed, because only one expectation can earn credit. The mutation pass exposed that gap and added the isolated case.

## Design vocabulary comes from base headings

A deterministic index supplies design.md’s headings and base line numbers, plus headings in local Markdown section links and split files under docs/design/. Fenced examples contribute no headings. Every entry is quoted as data and joins the instruction fingerprint. A 64 KiB UTF-8 bound refuses the complete index with an omitted-heading count. Missing linked sections refuse review. A design-only terminology golden asserts the base heading in its scripted conversation; no decision file can supply the term.
