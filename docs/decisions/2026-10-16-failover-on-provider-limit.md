# A provider's usage limit fails over to the tier's next model

Refines the failover clause of the pipeline guideline, "A lens whose model fails moves down its route". It replaces no decision.

Problem: when Codex hit its subscription limit, every round read `not reviewed`. `isFailoverError` moved a lens on only for a failed authentication or an error pi-ai would retry. pi-ai deliberately treats provider limits as non-retryable, which is right for retrying the same provider and wrong for failover.

Example: a heavy lens routes to Sol, then Opus. Sol replies `subscription_sharing_usage_limit_exceeded`. The lens failed with no attempt on Opus.

Choice, agreed by the maintainer on 2026-10-16: a provider limit error moves the lens, the verifier and every other routed task to the tier's next model. Sol stays first. pi-ai exports no classifier for limits, so `src/harness.ts` matches the strings pi-ai lists in `dist/utils/retry.js` and says so. A bare "billing" is narrowed to limit wording, since it also matches a malformed request that names a billing field, and the "usage limit" wordings of pi's Codex adapter are added, since pi-ai's list lacks them. Any other failure, such as a malformed request, still fails without trying another model.

Cost: Opus scores lower than Sol on design and durability, so a failed-over round is less precise there. An admin bypass on the ruleset remains for when both providers are out.
