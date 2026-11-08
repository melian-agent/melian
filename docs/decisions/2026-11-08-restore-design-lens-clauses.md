# Restore the design lens clauses that partial supersessions retired

Amends: [2026-10-07-design-lens-goldens-and-sources.md](2026-10-07-design-lens-goldens-and-sources.md) and [2026-10-08-decisions-package-markdown-on-mdast.md](2026-10-08-decisions-package-markdown-on-mdast.md), restoring clauses that partial `Supersedes:` lines retired.

Status: accepted on 2026-11-08 under step 26's audit, [issue #238](https://github.com/melian-agent/melian/issues/238).

[The goldens and sources decision](2026-10-07-design-lens-goldens-and-sources.md) and [the base-text decision](2026-10-07-design-lens-judges-against-base.md) each superseded [the design lens decision](2026-10-07-design-lens.md) for a few points. [The active-base decision](2026-10-08-design-lens-active-decisions-at-base.md) superseded the base-text decision while keeping two of its rules, and [the Markdown decision](2026-10-08-decisions-package-markdown-on-mdast.md) superseded the active-base decision for its parser and filename rules alone. The index retired each target whole. The clauses below still hold on main. This file restates them and changes nothing.

## From [2026-10-07-design-lens.md](2026-10-07-design-lens.md)

- The lens reads the diff plus the decision files and design sections the branch touches, and only those. A lens that read the whole design would spend its budget on rules the change does not reach.

## From [2026-10-08-design-lens-active-decisions-at-base.md](2026-10-08-design-lens-active-decisions-at-base.md)

- The lens loads every Markdown decision under docs/decisions at the comparison base through core's revision source. The decisions package parses titles and Supersedes targets. The complete graph is resolved before candidates are rendered. Every predecessor is marked inactive and names its direct successors. Only active base decisions supply baselines.
- The prompt lists every decision path and full title in path order. A 64 KiB UTF-8 byte bound holds the current base with headroom. An oversized index refuses review and names how many decisions were omitted. No row is shortened.
- Search and read_file accept the base revision, with the same bounds and untrusted boundaries as head reads. Step 1 searches base using its own terms as well as head terms.
- A new head decision that conflicts with behaviour an active base decision governs, without a `Supersedes:` or `Amends:` link, is a `criterion-selection-bias` finding on that new decision. A new file alone does not exempt it from the baseline.
- The graph belongs to deterministic review input, not model judgement. Its rendered input joins the instruction fingerprint, with the nonce excluded. Missing supersession targets, cycles and incomplete reads refuse the review. A single decision file may hold at most 256 KiB.
- The design lens stays in the full tier pending a later live measurement. Scripted runs prove the plumbing; the live run measures judgement. A missing credential or a missed quality bar is reported plainly, without loosening the goldens.
- Verification receives the active-base index for design-source claims and claims under a design rule. The rule catalogue comes from shipped lenses, without reloading repository lenses at base. Only a design verification candidate triggers the verifier's base-decision read. It judges whether the base reason still holds. A head decision that documents a weakening cannot excuse it.
- Golden scores count merged adjudicated defects, excluding refuted and dismissed findings. A match may use the speaker's reporting check and rule or a paired source and rule in otherClaims. Each original claim must be unrefuted to earn credit.
- A scoring test isolates a wrong-rule report.
- A deterministic index supplies design.md's headings and base line numbers, plus headings in local Markdown section links and split files under docs/design/. Fenced examples contribute no headings. Every entry is quoted as data and joins the instruction fingerprint. A 64 KiB UTF-8 bound refuses the complete index with an omitted-heading count. Missing linked sections refuse review.
- Three passes over the original eighteen design goldens gave mean precision 0.60 as sightings and 1.00 as adjudicated defects, with mean recall 0.94.

## From [2026-10-07-design-lens-judges-against-base.md](2026-10-07-design-lens-judges-against-base.md)

- A head-side edit to a decision is a change to judge. The lens reports a weakened trust, access, or fail-closed decision even when the decision file is edited alongside it, and quotes the base text it compared against.
- A decision file the diff deletes or renames is read at its old path at base. When it is active there, it is the baseline for whatever replaced it; when it was already inactive, its active base successors are.
