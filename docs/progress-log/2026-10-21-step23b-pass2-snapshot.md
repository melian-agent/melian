# Step 23b pass 2: consistent comparison reads

[Pull request #162](https://github.com/melian-agent/melian/pull/162) fixes Codex’s snapshot-race finding. ComparisonReader brackets its comparison read with detached round reads and retries when their values differ. Pi Durable exposes no public multi-document read transaction or generation token.

An orchestrated SQLite test reads the genuine version-1 fixture while another connection mints its first upgraded round. It failed before the fix by reporting the proven legacy comparison as unattributed. It passes after the fix. Inverting or removing the retry guard or the absent-round-document guard fails that test. All 73 comparison tests and type checking pass. No stored shape or plan status changes.
