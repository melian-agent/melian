# Step 23: the exact rule for comparing a pull request's rounds

[Pull request #148](https://github.com/melian-agent/melian/pull/148), phase 1 of plan step 23, "`melian compare` reaches a merged pull request's rounds".

[The rounds decision](../decisions/2026-10-18-compare-rounds-exact-rule.md) supersedes the direction-only decision of 2026-10-15 and settles its five open questions against the code at `ac4e8c07`. Rounds get an ID minted with their triage decision task. Writes name one round. GitHub's timeline decides which heads belong to `#N`, and stored round records decide what each round reviewed. Thread import writes the round at GitHub's head. A cross-round adjudication is one commit in the pull request's own storage.

`docs/design.md` gains a Round glossary row and a **Rounds** paragraph under the comparison section. The readiness questions and the plan point at the decision. No code or stored shape changes yet; the step stays not started until the attack on the decision is answered.
