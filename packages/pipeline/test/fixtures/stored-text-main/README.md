# A decided review and a pending publication from before Biome and tsc text was withheld

`main-8921ccb4/pending.sqlite` was recorded by `8921ccb4e208448ede620d44c279d1761173414b`, the merge base of [pull request #282](https://github.com/melian-agent/melian/pull/282), with its own locked dependencies and fake models. Its review ran `static.tsc` for real on a head whose type error quotes `ghp_FAKEoutsideTOKEN281`, so the stored finding holds tsc's own text. A publication was then parked before it ran, as in `../publish-rounds/`.

`capture.mjs` is copied to that source tree's root and run there:

```sh
node --conditions=@melian-agent/source capture.mjs <output-directory> <source-commit>
```

with git isolated from the user's configuration, as `fixtures/repo.ts` does. Nothing in the store is assembled by hand. `recorded.json` records the source commit, the changeset, the pending task ID and the fake GitHub state, and `repo.bundle` preserves the repository.
