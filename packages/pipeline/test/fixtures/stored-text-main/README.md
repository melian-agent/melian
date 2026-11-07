# Decided reviews and pending publications from before Biome and tsc text was withheld

Each directory's `pending.sqlite` was recorded by `8921ccb4e208448ede620d44c279d1761173414b`, the merge base of [pull request #282](https://github.com/melian-agent/melian/pull/282), with its own locked dependencies and fake models. Its review ran the named tier for real on a head whose tsc error quotes `ghp_FAKEoutsideTOKEN281` in a type, and whose unused variable Biome names. A publication was then parked before it ran, as in `../publish-rounds/`.

| Directory | Tier | A tool's text stored |
| --- | --- | --- |
| `tsc` | `static.tsc` | yes |
| `biome` | `static.biome` | yes |
| `mixed` | `guardrails, static.tsc` | yes |
| `guardrails` | `guardrails` | no |

`capture.mjs` is copied to that source tree's root and run there, once per directory:

```sh
node --conditions=@melian-agent/source capture.mjs <output-directory> <source-commit> <comma-separated tier>
```

with git isolated from the user's configuration, as `fixtures/repo.ts` does. It fails unless a tool's text was stored exactly when the tier runs Biome or tsc. Nothing in the store is assembled by hand. `recorded.json` records the source commit, the tier, the changeset, the pending task ID and the fake GitHub state, and `repo.bundle` preserves the repository.
