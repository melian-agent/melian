# Triage and the walkthrough fail over along their route

Amends: [A content filter's refusal fails over to the tier's next model](2026-11-20-content-filter-refusal-fails-over.md), "Triage and the walkthrough take the first model of their route with credentials and fail over on no failure", which no longer holds

Status: the brief of [issue #636](https://github.com/melian-agent/melian/issues/636), which a writer labelled ready. The coordinator's answer of 2026-11-22 on that issue's approach, the key and the stored shape is an answer on approach, not a ruling.

## Problem

A lens moves to its route's next model when one fails in a way another provider would not. Triage and the walkthrough asked only the first model of their route with credentials. When that model was at its usage limit, triage answered on no model and every lens ran at its default level, and the published walkthrough was a fixed note. Nothing in the verdict said triage had failed; only each lens's note did.

Example: on 2026-11-21 a host round on [pull request #532](https://github.com/melian-agent/melian/pull/532) ran while its Codex login was at its usage limit. Every lens failed over to its Claude fallback. Triage failed with `openai-codex/gpt-5.6-terra thinking=low failed: Codex error: The usage limit has been reached`, so every lens ran at `careful`, where the same lenses had run at `deep` on the earlier head. The walkthrough failed the same way. The round read as reviewed.

## Decision

Triage and the walkthrough move along their route by the rule a lens follows, `isFailoverError` in `packages/pipeline/src/harness.ts`: a transient failure, a failed login, a usage limit, or a content filter's refusal. Any other failure, and an aborted request, stops there as before.

- Triage's `RouteTextModel` holds every model of the route with credentials, in order, and keeps the route's head as its name. The decision records the model that answered as `model`, and each model that refused before it, with its reason cut to 200 characters, as `refused`. A route whose every model refused fails with a reason that names each.
- A review in which triage answered on no model carries the caveat `triage answered on no model, so every lens ran at its default level`. The terminal verdict prints every caveat as a `Reach:` line, as a publication already did, so a reader sees it without the lens notes.
- The walkthrough's task holds the route's credentialed models after the first as `fallbacks`, and counts the models asked in its checkpoint's `attempt`. Its conversation records the model that answered and the models that refused, by name alone, since the walkthrough is published and a provider's message is not. The host unlocks every provider the route may use, once.

The decision task's key and the walkthrough's request key are unchanged: each names the route's head, and the model that answered is the answer's, not the request's. [The identity guideline](../guidelines/identity.md) rows say so.

No stored shape takes a new version. An older build reads a decision's `refused` and a walkthrough's `fallbacks` and `attempt` as fields it does not know: `Decision` copies only the fields it names, and a harness marks every live walkthrough task for abort when it opens, so no checkpoint crosses builds.

## What it gives up

A decision or walkthrough a fallback answered while the head was at its limit is reused once the head is back. Asking the head again would cost another light-model call per review for an answer the route already accepts.

A triage record keeps each refusal's reason, so a reader tells a limit from a filter's refusal, where a lens records only a filter's refusal. A walkthrough records no reason at all.

The `melian round` workflow's comment does not print caveats, so it does not show this one; its verdict copy keeps no caveat field.
