# Working in packages/cli

@../../docs/guidelines/cli.md

## Rules

- Keep review logic out of the CLI. It chooses the policy source, storage, and models, then calls core and the pipeline.
- Import Pi only through `@melian-agent/pipeline` and `@melian-agent/pipeline/testing`, the latter for scripted mode alone.
- Run git with an argument array through `src/repository.ts`, never a shell string.
- Never print a credential. Name where it came from: a provider, an environment variable, or gh.
- A new command, or a new exit code, goes into `usage` in `src/main.ts` and the table in the guideline together.
- `publish` never posts what a range review or scripted mode stored.

## Running the tests

- Whole package: `npm test --workspace @melian-agent/cli`. It builds the CLI first, so it takes a few seconds more than its tests.
- By hand: `npm run build`, then `npx melian doctor` from the repository root.
