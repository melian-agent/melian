# Token telemetry: prove successful lens usage survives

[Pull request #146](https://github.com/melian-agent/melian/pull/146), final cold-round finding `9adc9ad834714ffa`.

Reading `missing..revision` on the successful `runGolden` path passed all 132 existing lens, retry and output tests. The new clean-rename test fails on that mutation: it receives no lens stages instead of six.

The test checks each returned lens stage's completed outcome and nonzero fake-model usage. It checks the exact revision against the real changeset resolver, then passes the unchanged result to the printer and checks its spend. Restoring the correct read passes all 17 output tests.

No production behaviour, guard or stored shape changes. The inventory and pass report under `tmp/` record the failing mutation and passing run. The whole gate follows after the verifier assertion fix.
