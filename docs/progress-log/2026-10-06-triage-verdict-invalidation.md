# Replacement triage invalidates the stored verdict

The sixteenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) found a stored verdict survived removal of its adjudication pointer.

The decision commit clears the revision's verdict, provenance, and decision. A SQLite crash regression checks findings and publication refuse it until replacement review completes. The review still attaches to finished lens tasks.
