# Working in Tally

Tally totals receipts and exports them as CSV.

## Code

- TSDoc only on exported package API. Nothing on internals.
- Import Node's built-in modules with the `node:` prefix.

## Documents

- If you change a behaviour that docs/design.md describes, change the document in the same commit.
- Link every GitHub issue and pull request you mention in a document, as [#12](https://github.com/tally-app/tally/pull/12). Never write a bare #12.

## Workflows

- Pin every GitHub Action to a full commit SHA, with its version in a comment, as `actions/checkout@<sha> # v4.3.0`.
