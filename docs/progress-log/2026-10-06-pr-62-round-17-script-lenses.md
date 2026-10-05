# Scripts retain every loaded lens

The seventeenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) found that filtering lenses before loading scripts rejected valid names.

The review plan and scripts again receive every loaded lens. Only the plan passed to credential unlocking is filtered by changed paths. Disabled and unmatched lenses still unlock no credentials.

Two fake-model CLI regressions name a disabled lens and a lens covering no changed paths. Both failed before the fix with "the script names correctness, which is not a lens here".
