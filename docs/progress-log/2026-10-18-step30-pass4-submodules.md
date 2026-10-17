# Step 30 pass 4: refuse submodule policy

[Pull request #147](https://github.com/melian-agent/melian/pull/147) refuses submodules as lens and policy directories.
A directory with a `.git` entry has kind `other`; its descendants are absent.
RevisionSource already behaves this way from Git's gitlink mode.
A symlink to a submodule retains its symlink kind.

Before the fix, six tests failed and seven passed.
Four failures loaded the narrowing correctness lens; one loaded submodule policy; one admitted an embedded repository.
A separate marker-read failure test also failed first.
The logs and mutation inventory are in `tmp/step30-pass4-report.md` and `tmp/step30-pass4-inventory.md`.
The implementation plan stays unchanged during this fix pass.

All 459 affected tests passed after updating one error path to name the earlier refused directory.
Type checking passed. M63–M70 all failed assertions, including symlink preservation and marker-read errors.
The whole gate runs again after the next fix, on the combined result.
Commit: `fix(core): refuse submodule policy directories`.
