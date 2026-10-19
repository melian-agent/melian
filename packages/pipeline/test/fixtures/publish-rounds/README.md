# Pending publication before round targets

These SQLite files were recorded by the code each directory names, with its own locked dependencies and fake models.
The capture ran from archived source trees under `tmp/`, as in the first rounds fixture capture.

| Directory | Source commit | Reviews at the revision | Publisher version | Publish task version |
| --- | --- | --- | --- | --- |
| `main-36122eb2` | `36122eb244b9b95cf84f39363a3e3106b6014482` | 1 | 2 | 5 |
| `build1-6bd298c0` | `6bd298c065e1092ff2a7caa6fa8d1b6ca2d9f2b4` | 2 | 2 | 5 |
| `build1-later-6bd298c0` | `6bd298c065e1092ff2a7caa6fa8d1b6ca2d9f2b4` | 3 (task created after 2) | 2 | 5 |

`capture.mjs` is copied to each historical source tree's root, then run there:

```sh
node --conditions=@melian-agent/source capture.mjs <output-directory> <source-commit> <review-count>
```

It runs `reviewChangeset`, closes the review harness, and opens the publisher with scheduling parked.
`publishReview` commits its target and task before the capture closes the harness.
Neither stored shape is assembled by hand. Writer trust is false, so reopening must preserve it.

`recorded.json` records the source commit, changeset, pending task ID and fake GitHub state.
`repo.bundle` preserves the source repository. `pending.sqlite` holds the target and unfinished task.
The build fixture holds `r1` and `r2` at one revision, but its old target names neither.
Only the main fixture can migrate to the revision's legacy round. The build fixtures are superseded because their round cannot be proven.

Pass `later-round` after the review count to capture a third decided round after the pending task is created.
The capture reopens with the review registry alone, so the old publish task remains blocked while real review code mints and decides r3.
