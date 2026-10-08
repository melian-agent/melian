# The design lens resolves active decisions at base before it reads the change

Supersedes: [2026-10-07-design-lens-judges-against-base.md](2026-10-07-design-lens-judges-against-base.md).

Problem: head searches chose the standards corpus inside the prompt. Old decisions stayed eligible after a successor had replaced them at base. Head terminology could hide the governing decision.

Example: base holds A and B, whose Supersedes line names A. A head following B could be reported against A. Another head renames writer trust to publisher eligibility and adds a conflicting decision without naming A. A search using the new terms finds only the head's excuse.

Choice: load every Markdown decision under docs/decisions at the comparison base through core's revision source. The decisions package parses titles and Supersedes targets. Resolve the complete graph before rendering candidates. Mark every predecessor inactive and name its direct successors. Only active base decisions supply baselines. Inactive text explains history and what changed.

The prompt lists at most 100 decisions in path order, with at most 512 characters per row and an omitted count. Search and read_file accept the base revision, with the same bounds and untrusted boundaries as head reads. Step 1 searches base using its own terms as well as head terms. A new head decision that conflicts with behaviour an active base decision governs, without a Supersedes link, is a criterion-selection-bias finding on that new decision. A new file alone does not exempt it from the baseline.

The graph belongs to deterministic review input, not model judgement. Its rendered input joins the instruction fingerprint, with the nonce excluded. Missing supersession targets, cycles and incomplete reads refuse the review. A single decision file may hold at most 256 KiB.

What this gives up: the list can omit distant candidates and shorten long rows. Base search and reads remain available to recover them. A Supersedes edge marks the whole predecessor inactive, even when prose narrows the replacement to one clause. Read successor text and docs/design.md for the retained choices; clause-level resolution stays with the reviewer. The parser follows dated Markdown filenames on Supersedes lines, not a general Markdown dependency language.

Codex's medium finding on [pull request #93](https://github.com/melian-agent/melian/pull/93) asked to remove design from the full tier until every rule had goldens and a three-pass live measurement. The lens is already in the full tier before that measurement. This change leaves the tier in place, as the maintainer instructed. Scripted runs prove the plumbing; the live run measures judgement. A missing credential or a missed quality bar must be reported plainly, without loosening the goldens.

## Verification follows the base baseline

The live investigation for [pull request #102](https://github.com/melian-agent/melian/pull/102) found the design lens reporting the trust defect correctly. The verifier refuted it because the head superseded its own decision. Verification now receives the active-base index for design-source claims and claims under a design rule. It judges whether the base reason still holds. A head decision that documents a weakening cannot excuse it. A scripted verifier golden requires the rule and base context, and retains this defect as confirmed.
