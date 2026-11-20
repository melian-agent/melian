# A content filter's refusal fails over to the tier's next model

Amends: [A provider's usage limit fails over to the tier's next model](2026-10-16-failover-on-provider-limit.md), "Any other failure, such as a malformed request, still fails without trying another model", which no longer covers a content filter's refusal

Status: the maintainer's ruling of 2026-11-20, in the coordinator session, for [issue #609](https://github.com/melian-agent/melian/issues/609).

## Problem

A tier lists fallbacks, and `isFailoverError` in `packages/pipeline/src/harness.ts` moves a lens to the next one when a model fails in a way another provider would not. A provider's content filter refusing the request was not one of those ways, so the lens failed, and the review read not reviewed.

Example: on 2026-11-20 Codex refused the probing lens's planner four times in a row on [pull request #532](https://github.com/melian-agent/melian/pull/532), and once on [pull request #576](https://github.com/melian-agent/melian/pull/576), each time with "Codex error: This content was flagged for possible cybersecurity risk. If this seems wrong, try rephrasing your request." Eight other lenses completed each time. The refusals cost about $17 of rounds that could not pass. A route in `melian.local.yaml` could not help, since a pull request's round reads routes from the base.

## Decision

A content filter's refusal moves a lens, its planner, its prober and the verifier to the next model of their route, as a usage limit does. The maintainer ruled on 2026-11-18 that a fallback a repository names is an equivalent review. A conversation that holds work gets the hand-over that tells the next model to continue, by [the fallback hand-over rules](https://github.com/melian-agent/melian/pull/574); the planner on #532 had made up to 13 tool calls before its refusal.

`isContentRefusal` recognises the refusal by the whole message each of pi-ai's adapters builds for one, read from `node_modules/@earendil-works/pi-ai/dist/api/`:

- Codex, `openai-codex-responses.js`: `Codex error: This content was flagged for possible `, then the provider's own text. pi-ai adds the prefix; the rest is the provider's, so only its opening is matched.
- Anthropic, `anthropic-messages.js`: `Provider stopped with: sensitive`, the safety filter's stop, and `The model refused to complete the request`, the `refusal` stop without an explanation.
- Chat Completions, `openai-completions.js`: `Provider finish_reason: content_filter`.
- Responses, `openai-responses-shared.js`: `Response incomplete: content_filter`.
- Bedrock, `bedrock-converse-stream.js`: `Provider stopped with: content_filtered`.
- Gemini, `google-generative-ai.js` and `google-vertex.js`: `Provider stopped with: ` and `SAFETY`, `PROHIBITED_CONTENT`, `BLOCKLIST` or `SPII`.

Each is anchored at both ends but Codex's, which is anchored at its start. A message that only mentions a filter, such as a malformed request that quotes "flagged", or text after a fixed message, does not match.

Left out, with the reason for each:

- Anthropic's `refusal` stop with an explanation. pi-ai passes the provider's explanation as the whole message, and no fixed text marks it, so it fails the lens as before.
- Bedrock's `guardrail_intervened`. A guardrail is a rule the account's owner set, and moving to another provider would step round it.
- Gemini's `RECITATION` and the image reasons. Recitation guards against quoting training data, not against the content sent, and a review sends no images.

A reminder, the turn that asks a planner or a prober for what it still owes, moves on the same way, from the model that answered, and a usage limit on one now moves it on too. Before, a reminder that failed in any way failed the lens, so a planner that finished without a plan could lose its review to a filter its fallback would pass.

The lens's record says which models' content filter refused it and which model answered, in its reason, beside the lineage the verdict already records. A failover on a limit adds no such note, so a reader can tell the two apart. The lens task reads each earlier attempt's settled submission to find them, so a review that resumes after a crash names refusals it did not see. When every model of the tier refused, the lens fails as before, and its reason says every model of its tier refused the content and names them. A lens whose next model fails in a way that does not move on still names the refusal before it.

Triage and the walkthrough take the first model of their route with credentials and fail over on no failure, so they do not fail over on this one either.

No wording a model is shown changes, so no request key moves for it, and the verifier's version stays. The recorded hash of `packages/pipeline/src/harness.ts` moves, so a stored result of the `adjudication` and `checks` producers, which reach that module, is decided again once.

## What it gives up

A pull request's content can now decide which model reviews it. Text that trips one provider's filter moves the review to the next accepted model. That model is one the tier accepts, so a guarded `accept` still holds, and the record names it. A round on such a change asks the refusing model first every time, so a rerun may cost more than a round on the first model would.
