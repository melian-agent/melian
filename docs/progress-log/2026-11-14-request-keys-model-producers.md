# Request keys: what a model producer's key leaves out

[Issue #394](https://github.com/melian-agent/melian/issues/394), [pull request #436](https://github.com/melian-agent/melian/pull/436).

The second Melian round's design lens found five instances of one class: the verification, walkthrough and triage keys hold what the model is asked, and nothing holds the code that handles its answer. Codex's sixth review found that a stored walkthrough stands by its revision and route, so its key decides only which task a review attaches to.

The coordinator advised on 2026-11-14 ([comment](https://github.com/melian-agent/melian/issues/394#issuecomment-6878170524)) to list both rather than fix them here. [The request keys decision](../decisions/2026-11-14-request-keys-as-built.md) now lists the producers' code and the retry setting among what a model producer's key leaves out, and the stored walkthrough as a fourth comparison narrower than a key. The identity guideline's three rows say the same. [Issue #437](https://github.com/melian-agent/melian/issues/437) is widened to the producers' code, and [issue #443](https://github.com/melian-agent/melian/issues/443) stores the key with each walkthrough.

`--rerun` asks again only for what failed, and for the walkthrough, so the decision names a new head, or a review with a `MELIAN_STATE_DIR` of its own, as what a user does meanwhile.

No code changed, so no mutation proof is owed.
