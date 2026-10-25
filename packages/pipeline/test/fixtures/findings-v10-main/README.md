# A finding stored before the carry

`main.sqlite` was written by main at `73e7a399` with its own review code and fake models: one decided review of `src/a.ts` whose correctness lens reported a `null-dereference` at line 3, so the store holds version 10 of `melian.findings`, with no carried sighting. `recorded.json` names the changeset, the revision key, the base, the head and the finding. `repo.bundle` holds the commits. No stored field was assembled by hand.

`capture.mjs` reproduces the capture when copied to the root of the `73e7a399` source tree, run there from `git archive 73e7a399` after `npm ci`, under Node 24 with `--conditions=@melian-agent/source`, git's global and system configuration off, and an absolute output directory.
