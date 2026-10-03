# Working in packages/pipeline

@../../docs/guidelines/pipeline.md

## Rules

- Only `src/harness.ts` imports `@earendil-works/pi-durable`, `@earendil-works/pi-ai`, or `@earendil-works/chord`. Everything else, in this package and every other, imports the harness through it. `test/harness-boundary.test.ts` fails the gate otherwise. The design lets core import pi-ai's types; widen the gate for `packages/core` in the change that first needs them.
- Read Pi Durable's API in `node_modules/@earendil-works/pi-durable/README.md` and its `dist/**/*.d.ts`, not from memory. [docs/spikes/pi-durable.md](../../docs/spikes/pi-durable.md) records what the spike proved and where the package differs from its announcement.

## Running the tests

- Whole package: `npm test --workspace @melian-agent/pipeline`.
- The spike alone: `npx vitest --run packages/pipeline/test/durable-spike.test.ts` from the repository root.
- The crash script by hand: `node packages/pipeline/test/fixtures/crash.ts <task|replay|memo> <file.sqlite> <log.jsonl>`. It parks once the scenario's first half is done; kill it with `kill -9` and read the log.
