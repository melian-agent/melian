# Probe the provider mutation survivors

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 3, starts from `16237d37`.
The host gate passed 4,664 tests there. Its mutation check found eight grouped survivors.

Provider tests now cover missing repositories, deleted pull requests, absent thread pages, empty and null comments, and ghost reply authors.
A valid empty thread page still asks REST before deciding that a root was deleted.
The ghost-author regression fails under the exact `comment.user.login` replacement, then passes after restoration.

Four provider findings are proposed as equivalent in the local `tmp/orphan-thread-equivalents.md`.
Three optional-chain findings still reject before writes; the empty-comment length check also precedes the first-comment access.
The array sentinel has no signed marker and is skipped, including among real signed records.
The pass applied every replacement by hand. The inventory and logs are in `tmp/orphan-thread-pass3-report.md`.
These probes change no production behaviour or design decision. The plan stays unchanged for this fix pass.
The whole gate follows the pipeline probes. No live models ran.
