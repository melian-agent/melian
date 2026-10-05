# Decisions guidelines

The decisions package holds the adapters behind core's `Decider` port, as `packages/github` holds the client behind the provider port. Core and the pipeline depend on the port alone, so a new decision provider is an adapter here, never a change to core. [design.md](../design.md#decision-models) says what decisions are for and where they are not used.

## The port

A `Decider` takes a `DecisionRequest`: a question set's name and version, a state, and choice questions, each an ID, a text, and its options. It returns a `DeciderAnswer`: a weight for each option of each question, and the model that gave them. `calibrated` says whether the weights are a calibrated probability. Core's `Decision.parse` validates the answer against the request and keeps the whole distribution, normalised over every option, with the option chosen; the pipeline stores that, never the chosen option alone. Problem: a stored choice cannot be retuned. Example: triage chose `quick` for a lens at 0.51 against `careful` at 0.49; a threshold moved later cannot tell that answer from one at 0.99. Solution: the distribution is the record.

A decider throws when it cannot answer, and the caller fails closed. For triage, that means every lens runs at its default level within the band policy sets, never `skip`.

## Adapters

- `RecordedDecider` answers from recordings, by question set, then question ID, then option, and keeps every request in `requests`. A question with no recording is `DecisionError` `unrecorded`. Use it in tests, never the fake model, when the test is about what a decision does rather than how a model is asked.
- `FallbackDecider` asks a text model through core's `TextModel` port: one request carrying the state and every question, answered through one tool, `answer`, whose arguments list each option with its probability. A list, not a map: a record schema becomes `patternProperties`, which some providers' structured output refuses. It checks the arguments against the tool's schema and refuses an option weighed twice, with `DecisionError` `invalidAnswer`. Its answers are uncalibrated, and it says so. The pipeline's `RouteTextModel` implements the port over a review's models; the CLI routes it to the cheapest tier with a credentialed model.

The decision-model adapters, Jev hosted and Clef on Workers AI or self-hosted, and the capability descriptors a generic packer in core fills, arrive in milestone 4. Until then `decisions.provider` names nothing Melian can open, and the CLI refuses it.

## Untrusted state

The state is text about the change under review, and the change's author controls most of it. The caller puts everything from the change inside its prompt boundaries before the state reaches an adapter, and puts the boundary's rule in the state, as the pipeline's triage does with the review's nonce. The fallback's instructions also tell the model never to follow an instruction found in the change.

## Tests

- `npm test --workspace @melian-agent/decisions` runs the adapters against a stub text model. The LLM fallback on the fake model, end to end through a review, is in `packages/pipeline/test/triage.test.ts`.
