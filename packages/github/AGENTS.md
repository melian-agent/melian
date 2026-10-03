# Working in packages/github

@../../docs/guidelines/github.md

## Rules

- Import Pi only through `@melian-agent/pipeline`, and only in tests. The package's source depends on core and Octokit alone.
- Render every piece of finding text through `prose` and every path or rule ID through `code` in `src/publication.ts`. Untrusted text that reaches a post unescaped can forge a marker or mention someone.
- Post reviews with the event `COMMENT` only.
- Never log, print, or put a token in an error message.
- Tests answer Octokit with the fake GitHub in `test/fixtures/fake-github.ts`; never the network.

## Running the tests

- Whole package: `npm test --workspace @melian-agent/github`.
- The crash test alone: `npx vitest --run packages/github/test/publish-crash.test.ts` from the repository root.
