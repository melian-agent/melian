# Quick verification survives the lens task upgrade

The merged verifier suite in [pull request #85](https://github.com/melian-agent/melian/pull/85) expected a version-2 task but created the current definition. Step 9 raised that definition to version 3.

The fixture now creates a task with stored definition version 2 using a version-2 definition. Review upgrades it to version 3, retains its quick level and verifies through the lens’s explicit setting. The model remains fake.

Validation runs the verifier suites before the full gate. An attempted assertion read the task after creating it in the same transaction and hit Pi’s ReadAfterWrite guard. It was removed; the fixture supplies the old version in its definition and checks version 3 after review. Results are recorded in `tmp/merge85-report.md`.
