# Spike: the record store port on git and a directory

Scripts for [issue #370](https://github.com/melian-agent/melian/issues/370), against the contract in [issue #368](https://github.com/melian-agent/melian/issues/368). They are not product code, and they use Node built-ins only.

- `store.mjs`: the envelope's canonical bytes and record ID, a throwaway Ed25519 signer, `GitRecordStore` and `DirectoryRecordStore`.
- `conformance.mjs`: one script, run unchanged against either adapter.
- `race.mjs`: separate writer processes, each with its own clone or handle, racing on `add` and on `writeCell`.
- `timing.mjs`: one `add` and one `list` against the remote.

The git adapter never checks out. Each write fetches the ref's tip and reads it into a throwaway index. It adds the blob with `update-index --cacheinfo`, or removes entries with mode-0 `--index-info` lines, since `--force-remove` needs a work tree. It then commits with `commit-tree` and pushes with `--force-with-lease=<ref>:<tip>`. A rejected push fetches and tries again.

```bash
node conformance.mjs dir <scratch dir>
node conformance.mjs git https://github.com/melian-agent/melian refs/heads/melian/spike-370
node race.mjs records git https://github.com/melian-agent/melian refs/heads/melian/spike-370 2 50
node race.mjs cell git https://github.com/melian-agent/melian refs/heads/melian/spike-370 5
node timing.mjs https://github.com/melian-agent/melian refs/heads/melian/spike-370 5
```

The report is on the issue.
