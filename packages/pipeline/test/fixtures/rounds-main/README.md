# Rounds before the rounds document

`pending.sqlite` and `decided.sqlite` were written by main at `ac4e8c07`, using its own review, comparison and adjudication code with fake models. `recorded.json` identifies the revision, pending task and findings. No stored field was assembled by hand. `repo.bundle` holds that review’s commits, so tests can ask git about its head and replay the range.

The capture runs a mutation-only review, imports an external finding, and closes the store. That is `decided.sqlite`. It then creates another adjudication through that commit’s task definition and leaves it pending. That is `pending.sqlite`. Reopen tests copy the files to temporary directories before writing.

`capture.mjs` reproduces the capture when copied to the historical source tree’s root. Run it with Node 24 and `--conditions=@melian-agent/source`, passing an absolute output path for `pending.sqlite`. Install that source tree’s locked dependencies first.

The builder’s sandbox denied both a linked worktree’s metadata and a separate bare clone. The capture therefore ran from `git archive ac4e8c07`, extracted under this worktree’s ignored `tmp/`, with a fresh `npm ci`. The capture imported only that historical tree’s code and dependencies.
