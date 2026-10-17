# Step 29 pass 6: prove the deterministic source fallback

[Pull request #144](https://github.com/melian-agent/melian/pull/144) adds a direct regression for findings without `reportedBy`.
A deterministic source still counts beside a refuted protected claim whose minimum is display-only.
Replacing the source fallback array with `[]` first survived the baseline run.
It now fails the new test because the deterministic report incorrectly becomes display-only.
Restored source passes the six-file core run recorded in `tmp/step29-pass6-findings-green.log`.

The temporary confirmed-record replacement with `{}` is equivalent.
The copied claim already has its reported severity and cleared verification; both arguments leave it unlowered and unrefuted.
Its ordinary decision has no unjudged cap, and neither temporary record enters a returned value.
The full reasoning and passing mutant run are in `tmp/step29-equivalents.md`.
No production code, stored version or plan status changes.
The final gate and CI result belong to `tmp/step29-pass6-report.md`.
