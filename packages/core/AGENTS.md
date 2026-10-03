# Working in packages/core

@../../docs/guidelines/core.md

## Rules

- Core never imports Pi Durable, Chord, or `@melian-agent/pipeline`. pi-ai types are the one permitted Pi import, and none is used yet.
- Read repositories by running `git` through `src/git.ts`. Pin every diff flag whose user configuration would change the output.
- Throw `ChangesetError`, `ConfigError`, `StandardsError`, or `OutsideRepositoryError` with a code, never a bare `Error` or a string.
- Only `ENOENT` and `ENOTDIR` mean a file is absent. Turn every other read failure into a typed error naming the path; a swallowed `EACCES` drops a standard from every review without a word.
- `src/index.ts` is the package's API, and only what it exports carries TSDoc.
- A new `melian.yaml` key goes into `melianYamlSchema`, `MelianConfig`, `defaultConfig`, and the key table in the guideline together.
