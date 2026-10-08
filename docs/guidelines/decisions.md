# Decisions guidelines

The decisions package parses written decisions for the design lens and holds the adapters behind core's `Decider` port, as `packages/github` holds the client behind the provider port. For model selection, core and the pipeline depend on the port alone. A new decision provider is an adapter here, never a change to core. The pipeline also loads written baseline decisions through DecisionFiles. [design.md](../design.md#decision-models) says what decisions are for and where they are not used.

## The port

A `Decider` takes a `DecisionRequest`: a question set's name and version, a state, and choice questions, each an ID, a text, and its options. It returns a `DeciderAnswer`: a weight for each option of each question, and the model that gave them. `calibrated` says whether the weights are a calibrated probability. Core's `Decision.parse` validates the answer against the request and keeps the whole distribution, normalised over every option, with the option chosen; the pipeline stores that, never the chosen option alone. Problem: a stored choice cannot be retuned. Example: triage chose `quick` for a lens at 0.51 against `careful` at 0.49; a threshold moved later cannot tell that answer from one at 0.99. Solution: the distribution is the record.

A decider throws when it cannot answer, and the caller fails closed. For triage, that means every lens runs at its default level within the band policy sets, never `skip`.

## Adapters

- `RecordedDecider` answers from recordings, by question set, then question ID, and keeps every request in `requests`. A question set's recordings name the version they were recorded for, and each answer may carry core's `questionFingerprint` of its question. A question with no recording is `DecisionError` `unrecorded`; a recording for another version, or whose fingerprint the question no longer has, is `staleRecording`. Problem: a question set's version changes when its questions do, and a recording keyed by name and ID alone answered a changed question with an answer made for the old one. Solution: the version and the fingerprint must match. Use it in tests, never the fake model, when the test is about what a decision does rather than how a model is asked.
- `FallbackDecider` asks a text model through core's `TextModel` port: one request carrying the state and every question, answered through one tool, `answer`, whose arguments list each option with its probability. A list, not a map: a record schema becomes `patternProperties`, which some providers' structured output refuses. It checks the arguments against the tool's schema and refuses an option weighed twice, with `DecisionError` `invalidAnswer`. It passes the decider's abort signal to the text model, so cancellation reaches an in-flight model call. Its answers are uncalibrated, and it says so. The pipeline's `RouteTextModel` implements the port over a review's models; the CLI routes it to the cheapest tier with a credentialed model.

The decision-model adapters, Jev hosted and Clef on Workers AI or self-hosted, and the capability descriptors a generic packer in core fills, arrive in milestone 4. Until then `decisions.provider` names nothing Melian can open, and the CLI refuses it.

## Untrusted state

The state is text about the change under review, and the change's author controls most of it. The caller puts everything from the change inside its prompt boundaries before the state reaches an adapter, and puts the boundary's rule in the state, as the pipeline's triage does with the review's nonce. The fallback's instructions also tell the model never to follow an instruction found in the change.

## Tests

- `npm test --workspace @melian-agent/decisions` runs the adapters against a stub text model. The LLM fallback on the fake model, end to end through a review, is in `packages/pipeline/test/triage.test.ts`.

## Written decisions

DecisionFile.parse reads a title and dated Markdown filenames on prose Supersedes lines. CommonMark paragraphs supply declarations; fenced and indented code and inline code examples create no edges. Link labels remain opaque, including code spans inside them. DecisionFiles.load reads the complete docs/decisions tree from the comparison base through core’s source reader, with 256 KiB per file. DecisionFiles.from resolves supersession before rendering. Missing targets and cycles throw DecisionFilesError. Source errors, including oversized files and symlinks, propagate rather than dropping a baseline.

DecisionFiles.render lists every path and full title, with active status or direct successors. The complete UTF-8 index is bounded at 64 KiB. Exceeding it throws an incomplete-baseline error naming the count omitted; no row or candidate is silently shortened. Repository-scale coverage checks every active decision at base and leaves headroom.

A Supersedes line beginning with “none” or “no decision file” declares no edge. Later links on that line are context. Without that check, the committed-routes decision incorrectly deactivates the review-plan decision it cites.

Decision discovery matches newlines in filenames. Git permits them; a dot without the s flag silently omits such a decision. Render paths through visibleText so they stay on one prompt row.

The design lens also receives a base index of headings and line numbers from docs/design.md and its linked local Markdown sections. Links with a section fragment and files under docs/design/ supply linked sections. Fenced examples supply no headings or links. CommonMark heading nodes supply ATX and Setext titles at their source lines, including permitted indentation and CRLF. Inline markup contributes its text. Code spans supply no links, including spans across lines. The complete index has a 64 KiB UTF-8 bound; an overrun or unreadable linked section refuses review. Base headings guide searches when the head renames a concept. The index uses listing boundaries and joins the instruction fingerprint.

CommonMark parsing resolves section link destinations, including reference links and optional titles. Only used references supply sections; unused definitions and images do not. Duplicate definitions use the first destination. Angle brackets, balanced parentheses, escapes and character references follow the parser's rules. External URLs with a scheme and raw protocol-relative destinations beginning with // supply no repository sections. Encoded leading slashes remain local path input and are refused after decoding. Section paths are URI-decoded after removing queries and fragments, then normalised relative to docs/design.md. Malformed encoding and paths outside the repository refuse review. Fragment-only links use design.md’s own headings.

A closing fence must use the opening marker, be at least as long, and have only spaces or tabs after it. Trailing text keeps the fence open. A backtick opening fence cannot contain a backtick in its info string. CRLF endings follow the same rules.

Markdown Supersedes links supply their destinations only; dated filenames in display text or optional titles create no edges. CommonMark parsing resolves inline and reference links, including angle brackets, balanced parentheses, escapes and character references. Decode the destination’s path after removing its query and fragment. Only a complete local dated Markdown path creates an edge; external URLs and partial filename matches do not. Malformed percent encoding refuses the graph. Bare filenames outside links remain targets. Supersedes targets resolve against the declaring file’s directory. A docs/decisions-prefixed target keeps its repository-relative path; a leading slash starts at the repository root. Nested files with the same dated basename therefore remain distinct.

A character reference in a Markdown destination can decode to a newline. Git permits that newline in a directory name. Encode it before scanning Supersedes lines, then decode it with the destination path; otherwise line scanning silently drops the edge.
