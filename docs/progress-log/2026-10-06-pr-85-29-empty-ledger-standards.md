# Prove empty per-lens standards stay explicit

The mutation inventory for [pull request #85](https://github.com/melian-agent/melian/pull/85) adds a lens with no standards to the ledger fixture. Its visible run-details line must end with standards none. Removing that fallback fails the assertion. No production behaviour or design decision changes.
