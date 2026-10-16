# Stage telemetry pass 4 proof record

[Pull request #135](https://github.com/melian-agent/melian/pull/135).

- `24b9424e` preserves version-2 publisher trust and identity. Four SQLite reopen tests failed before the fix and pass after it. Main's own version-2 publisher wrote the new untrusted-task fixture.
- `905c1a09` adds direct reader tests. They kill 22 named mutations; two redundant undefined-time guards are equivalent.
- `39593e33` proves the original start survives an active abort after Pi clears task memos.
- `099cba3d` proves the initial check run creates no source map for an undefined parent. The missing-source assignment mutation is equivalent because Pi omits undefined properties.
- `5e05ae71` exercises timing commands in process and kills 11 CLI mutations. The initial JSON-mode flag is equivalent because parsing overwrites it before use.

The cold text contains 38 named mutation findings: 34 killed and four equivalent. The separate abort-path finding is also killed, with none of the requested findings unresolved. Both forced outcomes of the new version guard fail tests. No Stryker suppression was added. Equivalent reasons, exact mutations and failing output are recorded under the worktree's `tmp/`.

The other timing migrations retain their inputs and only add the legacy timing marker. No step status changed, so the implementation plan stays as it is. The coordinator still owes the host gate, automatic mutation and the next model review; this sandbox denies the process enumeration those checks need. The local gate and CI results are recorded in `tmp/stage-telemetry-pass4-report.md`.
