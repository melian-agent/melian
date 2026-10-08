# Round thirteen fixes for [pull request #102](https://github.com/melian-agent/melian/pull/102)

- `62a0ee1cf47548ba8405d246601a81c5960180a0` fixes P2: absence sentinels now share the bare-target boundary. Filenames beginning with none retain their supersession edges. Full stops before whitespace or the line end still suppress later contextual links.
- `9db5d9e54d9d51c610597f60c28f670bd40af9f3` fixes P3: both direction-control fixtures construct U+202E with String.fromCharCode. Their runtime values and visible expectation stay unchanged.

Twenty sentinel and boundary mutations failed named tests. Restoring the word boundary fails the filename regressions. Removing the full-stop clause fails the live absence forms. Removing U+202E from the positive fixture fails its visible-control expectation. The report records every probe and failed test.

After Biome, the branch-wide control scan found no literals in the requested ranges. macOS grep does not support -P; rg ran the same pattern.

Validation: the full gate passed on its first run, exit 0. No timeout retry was needed. The restored sentinel tests passed: two files, 176 tests. The restored section tests passed: one file, 198 tests. Type checking and git diff --check passed. Logs and the mutation inventory are in tmp/fix102-r13-report.md.

Full gate summary:

```text
Checked 241 files in 640ms. No fixes applied.
found 0 vulnerabilities
 Test Files  111 passed (111)
      Tests  3359 passed | 50 skipped (3409)
   Start at  22:53:42
   Duration  400.94s (tests 97%, import 3%)
```
