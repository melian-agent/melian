# A head's Packwerk change draws a policy notice, 2026-11-20

[Issue #538](https://github.com/melian-agent/melian/issues/538). Enola's Packwerk check read `packwerk.yml` and each `package.yml` from the head, so a head could turn it off with no notice. By the maintainer's ruling of 2026-11-18 on that issue, the Enola check now raises `guardrail/policy-change-review` at acknowledge for each Packwerk file Enola's facts name, at base or head, that the head changes. [The decision](../decisions/2026-11-20-packwerk-changes-draw-a-policy-notice.md) says why the Enola check raises it and how it resolves as the guardrails check's own. The check request raises `static.enola` to version 6.

Files that guard trust: `packages/core/src/guardrails.ts`, `packages/core/src/findings.ts`, `packages/core/src/enola-graph.ts`, `packages/pipeline/src/enola-static.ts` and `packages/pipeline/src/checks.ts`. They decide what a head's change draws and how it resolves. `packages/pipeline/src/check-request.ts` decides what a run is reused for. None writes a stored shape.

Tests: `packages/core/test/packwerk-notices.test.ts`, a new case in `packages/pipeline/test/checks.test.ts` and one in `packages/pipeline/test/enola-static.test.ts`. On main's source the core file fails, since nothing raises the notice, and the checks case fails with the Enola record counting 0 findings where it should count 1.
