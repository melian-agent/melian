# Cover opt-out and stored standards upgrades

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, item 3.

An empty supplied checks list now has a regression on a capable wrapper, with no policy. It leaves missing records not reviewed and creates no deterministic task in the durable checks index.

The SQLite lens-resume test now covers task versions 1 and 2. Version 2 retains its input, routes, instructions and scrutiny level across a reopen. Its findings keep the level in their producer identity. The version-1 identity remains covered.

A recorded version-5 fixture was possible. The historical code at 5b79a4e ran a review and publication through fake models and fake GitHub. Its document snapshots are checked in with provenance. A SQLite regression reads both through the current migrations, writes per-lens standards, and verifies them after another reopen.
