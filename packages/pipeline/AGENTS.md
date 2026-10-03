# Working in packages/pipeline

@../../docs/guidelines/pipeline.md

## Rules

- Only `src/harness.ts` and `src/testing.ts` import `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, or `@earendil-works/chord`. Everything else, in this package and every other, imports them through those two. `test/harness-boundary.test.ts` fails the gate otherwise. The design lets core import pi-ai's types; widen the gate for `packages/core` in the change that first needs them.
- `src/harness.ts` is an import quarantine, not a stable API. It re-exports Pi's experimental types and functions, so a changed signature upstream still reaches every caller. As steps 5 and 7 add callers, grow a narrow Melian-owned facade in front of it. Raw Pi types do not cross out of `packages/pipeline`.
- Test helpers live in `src/testing.ts`, exported as `@melian-agent/pipeline/testing`. `src/index.ts` exports runtime API only.
- Read Pi Durable's API in `node_modules/@earendil-works/pi-durable/README.md` and its `dist/**/*.d.ts`, not from memory. [docs/spikes/pi-durable.md](../../docs/spikes/pi-durable.md) records what the spike proved and where the package differs from its announcement.

## Running the tests

- Whole package: `npm test --workspace @melian-agent/pipeline`.
- The spike alone: `npx vitest --run packages/pipeline/test/durable-spike.test.ts` from the repository root.
- The crash script by hand: `node --conditions=@melian-agent/source packages/pipeline/test/fixtures/crash.ts <task|replay|memo|finding> <file.sqlite> <log.jsonl>`. It parks once the scenario's first half is done; kill it with `kill -9` and read the log.
