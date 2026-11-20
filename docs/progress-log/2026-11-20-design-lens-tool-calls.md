# Design lens tool-call limit, 2026-11-20

The design lens's tool-call budget goes from 400 to 600 in `.melian/lenses/design/LENS.md`. [The decision](../decisions/2026-11-20-design-lens-tool-calls-fit-a-large-change.md) says why: with the token budget at 10,000,000, the 400-call limit became the one a large change meets first. `packages/core/test/lens.test.ts` pins the new budget and the lens's new version. No code changed, and no file here guards trust or durability.
