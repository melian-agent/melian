# The design lens resolves active decisions at base before it reads the change

Supersedes: [2026-10-07-design-lens-judges-against-base.md](2026-10-07-design-lens-judges-against-base.md).

Problem: head searches chose the standards corpus inside the prompt. Old decisions stayed eligible after a successor had replaced them at base. Head terminology could hide the governing decision.

Example: base holds A and B, whose Supersedes line names A. A head following B could be reported against A. Another head renames writer trust to publisher eligibility and adds a conflicting decision without naming A. A search using the new terms finds only the head's excuse.

Choice: load every Markdown decision under docs/decisions at the comparison base through core's revision source. The decisions package parses titles and Supersedes targets. Resolve the complete graph before rendering candidates. Mark every predecessor inactive and name its direct successors. Only active base decisions supply baselines. Inactive text explains history and what changed.

The prompt lists every decision path and full title in path order. A 64 KiB UTF-8 byte bound holds the current base with headroom. An oversized index refuses review and names how many decisions were omitted. No row is shortened. Search and read_file accept the base revision, with the same bounds and untrusted boundaries as head reads. Step 1 searches base using its own terms as well as head terms. A new head decision that conflicts with behaviour an active base decision governs, without a Supersedes link, is a criterion-selection-bias finding on that new decision. A new file alone does not exempt it from the baseline.

The graph belongs to deterministic review input, not model judgement. Its rendered input joins the instruction fingerprint, with the nonce excluded. Missing supersession targets, cycles and incomplete reads refuse the review. A single decision file may hold at most 256 KiB.

What this gives up: a corpus whose complete index exceeds 64 KiB needs a larger reviewed bound before design review can run. A Supersedes edge marks the whole predecessor inactive, even when prose narrows the replacement to one clause. Read successor text and docs/design.md for the retained choices; clause-level resolution stays with the reviewer. The parser follows Markdown filenames on Supersedes lines, not a general Markdown dependency language.

## Supersession links name complete local destinations

A Markdown link title may cite another decision without superseding it. For example, `Supersedes: [A](2026-10-01-a.md "See 2026-10-02-b.md")` replaces A alone. CommonMark parsing separates destinations from labels and titles for inline and reference links. It handles angle brackets, balanced parentheses, escapes and character references. URI decoding follows removal of the query and fragment. The complete local path must name a Markdown file under docs/decisions; an external URL or filename inside another path creates no edge. URI schemes and network-path links are excluded before decoding. Colons in later local directory segments remain part of the destination. Malformed local percent encoding refuses the graph. Only prose paragraphs supply Supersedes declarations. Fenced and indented code and inline code examples create no edges. An example must not deactivate a governing decision. Link labels remain opaque, including code spans inside them. Bare filenames still resolve against the declaring directory. A leading slash starts at the repository root. The parser and its types are exact-pinned dependencies; hand-written link regexes cannot cover these forms.

Codex's medium finding on [pull request #93](https://github.com/melian-agent/melian/pull/93) asked to remove design from the full tier until every rule had goldens and a three-pass live measurement. The lens is already in the full tier before that measurement. This change leaves the tier in place, as the maintainer instructed. Scripted runs prove the plumbing; the live run measures judgement. A missing credential or a missed quality bar must be reported plainly, without loosening the goldens.

## Verification follows the base baseline

The live investigation for [pull request #102](https://github.com/melian-agent/melian/pull/102) found the design lens reporting the trust defect correctly. The verifier refuted it because the head superseded its own decision. Verification now receives the active-base index for design-source claims and claims under a design rule. The rule catalogue comes from shipped lenses, without reloading repository lenses at base. Only a design verification candidate triggers the verifier’s base-decision read. It judges whether the base reason still holds. A head decision that documents a weakening cannot excuse it. A scripted verifier golden requires the rule and base context, and retains this defect as confirmed.

## Scoring follows adjudication

Golden scores count merged adjudicated defects, excluding refuted and dismissed findings. A match may use the speaker’s reporting check and rule or a paired source and rule in otherClaims. Each original claim must be unrefuted to earn credit. A confirmed co-report can keep the defect live without making its refuted design claim eligible. Speaker matching uses its original verdict, since the merged verdict may come from another claim. Scripted assertions select only eligible claims. Alternative files let a finding cite the faulty code or its conflicting decision. A second lens sighting the same defect is not a false positive. The live supersedes case cited the code correctly; its old expectation accepted only the decision path.

A scoring test must isolate a wrong-rule report. Supplying it beside a correct report leaves precision unchanged when the rule check is removed, because only one expectation can earn credit. The mutation pass exposed that gap and added the isolated case.

## Design vocabulary comes from base headings

A deterministic index supplies design.md’s headings and base line numbers, plus headings in local Markdown section links and split files under docs/design/. Fenced examples contribute no headings. CommonMark heading nodes supply ATX and Setext titles at their source lines, including permitted indentation and CRLF. mdast-util-to-string supplies heading text, including image alt text and code span text, while excluding HTML nodes. github-slugger supplies IDs. Every entry is quoted as data and joins the instruction fingerprint. A 64 KiB UTF-8 bound refuses the complete index with an omitted-heading count. Missing linked sections refuse review. A design-only terminology golden asserts the base heading in its scripted conversation; no decision file can supply the term.

Section links use CommonMark destinations, including used references and optional titles. For example, `[Trust][policy]` with `[policy]: design/trust.md#writer-trust` loads that section or refuses review when it is absent. Unused definitions, images and code examples supply no section links. WHATWG URL parsing classifies destinations against a repository-local file base before URI decoding. A different protocol or host, or an absolute URL that needs no base, supplies no repository section. Colons in later path segments and percent-encoded schemes remain local paths. Encoded leading slashes remain local path input and are refused after decoding. Section paths are URI-decoded after removing queries and fragments, then normalised relative to docs/design.md. Malformed URLs, malformed encoding and paths outside the repository refuse review. Fragment-only links use design.md’s own headings. Duplicate definitions use the first destination.

File URLs share a null origin. Compare the destination under two file bases with different hosts. A relative path inherits each host; a protocol-relative destination keeps its own host under both. One synthetic host alone mistakes a destination naming that host for a local path. Absolute URLs are excluded even when a file URL inherits the base host. URL parsing must precede URI decoding: `https%3A//host/trust.md` names a local path, while `https://host/trust.md` names an external URL. A colon after a slash, as in `design/writer:trust.md`, must not bypass heading discovery or missing-section refusal.

## Live measurement and its limits

Three passes over the original eighteen design goldens gave mean precision 0.60 as sightings and 1.00 as adjudicated defects, with mean recall 0.94. Co-reporters inflated the sighting denominator. The supersedes miss had two causes: its expectation accepted only the decision file while the lens cited faulty code, and the verifier accepted the head’s superseding decision as an excuse.

The recorded findings exist for fail-open-default, trust-by-label and supersedes. Rescoring their retained lens findings gives precision 1.00 in each. Recall is 1.00 for the first two and 0.00 for supersedes, whose historical verdict remains refuted. The full-corpus adjudicated precision follows the investigation’s duplicate diagnosis; the saved findings directly verify only these three cases. No live provider was called for this fix pass. The new verifier and terminology cases prove the scripted contracts; their live judgement remains unmeasured.

## Parser coverage follows input classes

The repeated design-section defects came from a parser design that added one regular-expression exception per review finding. CommonMark nodes now define Markdown syntax. Concern tables pair valid inputs with inert or refused inputs for destinations, fragments, headings, revision reads and byte bounds. The tables preserve each earlier failure scenario. Heading text includes image alt text; an image destination still supplies no section link. HTML nodes supply no vocabulary text. A fragment selects the linked file, not a subset of its headings. Discovery follows links in design.md alone, without recursively walking linked files.

Vitest truncates object values interpolated through a $name title. A mutation selected by the full destination then runs zero tests. The table passes its name as a tuple string through %s, which preserves the whole title. Mutation checks must also confirm that a named test failed, rather than accepting any non-zero exit.

## Local supersession paths retain colons

The design-section URL fix exposed the same mistake in supersession discovery. The destination nested/writer:trust/2026-10-01-a.md is local, yet excluding every colon from its directory segments dropped the edge and left A active. Classify a URI scheme at the start, or a network-path prefix, before decoding. Then accept colons in the complete local path. Encoded scheme characters stay local path input. Tests assert both the predecessor’s inactive row and refusal when it is absent. External destinations with malformed encoded paths remain external and create no edge.

## Markdown grammar belongs to unified

[The Markdown decision](2026-10-08-decisions-package-markdown-on-mdast.md) replaces the parser and filename rules. MarkdownDocument owns one mdast tree, definition lookup and document-local GitHub heading IDs. YAML and TOML front matter are metadata. LocalDestination owns URL resolution for section links and supersession targets. Discovery and supersession accept the same Markdown filename domain, including undated, Unicode and names containing newlines. The active-base graph, prompt sections, complete heading index and byte bounds remain as specified above.
