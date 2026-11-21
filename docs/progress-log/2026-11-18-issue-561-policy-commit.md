# Issue 561: misses reviewed under one named policy

[Issue #561](https://github.com/melian-agent/melian/issues/561) compares two arms over 21 misses from many pull requests. Each miss was reviewed under its own base's policy, so the arms would measure 21 policies, most of them older than the lenses the comparison is about.

`MELIAN_EVAL_POLICY_COMMIT` names one commit, such as `main`, whose policy, standards and lenses review every miss. The probing measurement takes it as an option; the parity run requires it and refuses misses whose clones resolve it to different commits. While probes run, the policy commit must be vouched for beside the base and head. Every refusal now names its check, and the parity run lists every refused miss in one exit, or, with `MELIAN_EVAL_PARITY_DRY=1`, lists them with each scorable miss and stops before any provider, so the host can count how many of the 21 today's policy can score before it spends anything. The results file records the policy commit, and a resume refuses another.

Goldens keep their own policy. The run record's template now says that today's standards judge old code.
