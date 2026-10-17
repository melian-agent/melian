# Step 30 pass 4: notice symlink type changes

[Pull request #147](https://github.com/melian-agent/melian/pull/147) now notices a policy file becoming or leaving a symlink, even with the same blob.
Git supplies the mode and blob together.
A regular or executable file keeps its blob identity; a symlink uses `symlink:<blob>`.
The type binds both comparison and dismissal without changing stored shapes or ordinary file triggers.
Executable-bit-only changes stay quiet under the forced rule.

Five tests failed first: policy and both lens locations becoming symlinks, and both lens locations returning to regular files.
The decision carries forward every clause of the exact nested policy rule while adding the file-type binding.
The report and inventory are `tmp/step30-pass4-report.md` and `tmp/step30-pass4-inventory.md`.
The whole gate runs on the combined pass. The implementation plan stays unchanged during this fix pass.

All 122 affected tests passed, as did type checking. M71–M77 failed assertions.
M78, removing `trim()`, is equivalent: Git emits consistent record endings and `snippetHash` removes whitespace beside punctuation.
A five-case hash check records that proof in the local report. All trust guards have killed mutations.
Commit: `fix(core): notice policy symlink type changes`.

The combined whole gate exited 1 after 616.72 seconds: 4,771 passed, 53 skipped, and four known sandbox process failures.
All 29 new tests passed. No test timed out. Lint, types, dependency checks and the audit threshold passed.
The report names the three `ps` skips and four failures. The coordinator must rerun the gate and cold mutation check on the host.
The spelling and submodule commits passed CI at their exact heads.
