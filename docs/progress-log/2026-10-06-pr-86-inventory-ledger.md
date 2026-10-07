# Prove ledger attribution defaults

[Pull request #86](https://github.com/melian-agent/melian/pull/86)’s inventory found four unguarded rendering defaults. Tests now require unknown identity and permissions, default trusted writers for old rounds, explicit trust on and off, and known attribution. Mutations also drop known values and bypass login escaping.
