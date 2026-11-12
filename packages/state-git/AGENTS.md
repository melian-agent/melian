# Working in packages/state-git

@../../docs/guidelines/state-git.md

## Rules

- Never check the state branch out. Build its trees and commits with git's plumbing in the clone's object database, so a checkout of one changeset never touches another's files.
- Every push names the tip it fetched with `--force-with-lease`. Retry only a lost race: a refusal Git reports as stale info, or a remote that could not lock the branch's ref. Wait a random time below a bound that doubles from 50 ms to a second, fetch again and decide afresh, and give up after ten attempts with `pushFailed` naming which race was lost.
- Read nothing from the branch before checking it: a changeset tree holds only the names Pi's JSONL storage writes, and `index.json` only the version this build reads.
- Run git through core's `git`, which removes the repository-local variables a hook sets.

## Running the tests

- Whole package: `npm test --workspace @melian-agent/state-git`.
