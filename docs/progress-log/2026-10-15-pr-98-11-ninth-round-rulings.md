[Pull request #98](https://github.com/melian-agent/melian/pull/98): the maintainer's rulings on round nine (466 seconds of wall time, not reviewed).

- 43ad75f6: under `--trust-head`, the mutation check's enablement and timeout come from the working tree. A range not vouched for takes them from the base. With base settings, this pull request's own review could not run the check it adds. Tests give base and head different values and see which one applies. That retires 9e87ec066356fd40.
- 3f7df1a6: `WriterTrust` loses `checkout`, which no review grants. Melian reviews commits, and a committed range is the reviewer's own only on their word.
- 1fd33e59, for e912a2550b3ae78a: the installation identity digests `package-lock.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock` and `bun.lockb`, each where present. Melian runs Stryker under Node whatever installed `node_modules`, so a Bun install is one it runs. The identity's shape changed, so a test shows no partition written under the old identity is reused, and the version needs no bump.

Mutations, each run by hand and each failing a test: the settings override never applied, applied always, or inverted; each of the five lockfiles dropped. Renaming the identity's key back to `lockfile` survives. The value's shape still differs from the old one, so it is equivalent for what the test guards.
