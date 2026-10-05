The tenth review of [pull request #62](https://github.com/melian-agent/melian/pull/62) found no test for the refusal message when a lens declares none of its policy band's levels.

A core test now pins the message for a careful-only lens under a floor of deep. A pipeline test checks that the same case fails the review with that message before either triage or a lens asks a model. The behaviour is unchanged.

The gate's two CLI storage tests failed because the calling session set MELIAN_STATE_DIR. The CLI test helper inherits that variable, so tests expecting .git/melian instead used the caller's directory. Run the gate with MELIAN_STATE_DIR unset when the session supplies it.
