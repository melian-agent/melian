# Enola static policy

Choice: Add opt-in `static.enola`, disabled in defaults and absent from default tiers. Melian's own fast tier enables it. A missing pin, provisioning failure, unreadable artifact, timeout, or exit 2 or 3 fails the check. Exit 0 or 1 supplies SARIF; severity follows Biome and remains overridable.

Both worktrees use the base's Enola policy. The effective configuration disables providers and history and forces a single repository. The runner replaces head configuration, constraints, intent, and suppressions with bounded base copies. A committed baseline is removed. It generates base and head, pins base in scratch, and diffs SARIF by Melian's snippet identity. Resolved and explicitly suppressed SARIF results are excluded. An unlocated finding uses the intent path.

Upstream requires output.dir inside the repository and offers no provider-disable flag. A runner-owned `.enola` symlink targets scratch; an effective config with `providers: []` prevents executable providers. HOME is temporary and update checks are disabled. No binary enters PATH. These are the two departures from the suggested command sketch, required by the inspected v0.4.27 source.

`CacheLocation` shares the state-directory rule with binaries and later graphs. Check records gain optional snapshot identities and original receipt strings. A receipt is not byte-stable: upstream records generation time, duration, and path. Its identity and fact bytes can be stable. The report will measure that distinction.
