# Working in packages/github

@../../docs/guidelines/github.md

## Rules

- Import Pi only through `@melian-agent/pipeline`, and only in tests. The package's source depends on core and Octokit alone.
- Render every piece of finding text through `renderProse` and every path or rule ID through `code` in `src/publication.ts`. Untrusted text that reaches a post unescaped renders as live markdown in the maintainer's voice: a link, a heading, a mention, or an issue reference. Only Melian's own template carries markdown.
- Sign every marker with the publisher secret the call carries, and count a marker read back only when its signature verifies. The author is a filter, never the proof.
- Post reviews with the event `COMMENT` only.
- Never log, print, or put a token or the publisher secret in an error message.
- Tests answer Octokit with the fake GitHub in `test/fixtures/fake-github.ts`; never the network.

## Running the tests

- Whole package: `npm test --workspace @melian-agent/github`.
- The crash test alone: `npx vitest --run packages/github/test/publish-crash.test.ts` from the repository root.
