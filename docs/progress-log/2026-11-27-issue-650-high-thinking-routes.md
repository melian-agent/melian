# Issue 650: Melian's own review routes run at high thinking

For [issue #650](https://github.com/melian-agent/melian/issues/650), the first fix from the maintainer's parity loop.

The root `melian.yaml` sets `thinking: high` on the light, medium and heavy tiers, in place of `low`. The design lens's own route and the verifier are unchanged. [The decision](../decisions/2026-11-27-melians-own-routes-run-at-high-thinking.md) records the measurement: recall on three re-reviewed pull requests rose from 24% to 39%, at $6.31 per change against $4.04. It amends the three decisions that set the old levels.

Two tests read the committed routes, `packages/cli/test/models.test.ts` and `packages/core/test/lens.test.ts`, and now expect `high` in the lens and triage requests. `melian doctor` prints `high` for the three tiers. No golden's `melian.golden.yaml` reads the root routes, so none changed.

`docs/design.md`, `AGENTS.md`, `README.md` and step 33 of the plan now state the new level. The change guards neither trust nor durability, so it owes no mutation inventory.
