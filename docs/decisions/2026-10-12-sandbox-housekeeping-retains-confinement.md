# Sandbox housekeeping retains confinement

Supersedes: none. [The sandbox decision](2026-10-08-head-code-runs-in-a-sandbox.md) stands, and this adds to it.

Problem: head code can leave a symlink or replace a scratch directory while housekeeping runs. A host read or recursive deletion could then follow it outside the run.

Choice: the sandbox decision's rule is unchanged. Every check that executes head code runs in a sandbox; a host with neither backend skips it with leave; writer trust remains a second control.

One rule: the host never follows a path that confined code could have written. One reader enforces it. `Run.readOutput` is the only way the host reads a file under a run's scratch, and it goes through `MutationScratch.read`: a link refused at every component under scratch, an atomic no-follow open, a regular file only, and a bound, read once. That covers a tool's report, its error file, its output file, git's own listings, and the head's `tsconfig.json`. Before this rule the host resolved a report through a link and read the target, so a subverted Biome could point `biome.err` at a credential and have the host put it in the check's stored error. A refusal names the path and its reason, never what the path led to. Where the host has no sandbox the reader's script runs on the host and its own guards are the whole defence; where it has one, the script runs inside it as well. The scratch directory is used by its resolved path or the run fails, since the reader refuses a link above scratch too.

Scratch housekeeping stays confined after head code ends. The host retains its policy in memory and refuses symlink components. Log, report and staged-cache reads require regular files and atomic no-follow opens. A refused path is recorded without reading its target into an error.

Cleanup removes each tree under retained confinement, then scratch, then its own registrations. Missing trees, a missing scratch and an absent registration remain harmless on retry. [The cleanup-order decision](2026-10-12-mutation-cleanup-keeps-scratch-until-unregistered.md) records the order and why the registration goes last.

Host git never recursively deletes a head-written tree. A surviving process could recreate a deleted path before unregistering it. The host removes only its own entries in the trusted repository’s registration metadata, each matched by the tree it names; it never prunes.

[Pull request #98](https://github.com/melian-agent/melian/pull/98) found the need for these controls. They are recorded here without rewriting or retiring the earlier decision: the index retires a superseded file whole, and the rule in it is still relied on.
