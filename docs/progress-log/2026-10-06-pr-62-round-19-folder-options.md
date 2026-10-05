# Shared triage options from later variants

The nineteenth Melian round on [pull request #62](https://github.com/melian-agent/melian/pull/62) found a gap in the shared-question test.
Its first folder variant already offered every option, so dropping the later variant's options would still pass.

The new regression orders a careful-only variant before a deep-only variant.
It checks that their one shared question offers both levels and each run keeps its own band.
The test passes with the union and fails when a temporary mutation keeps only the first variant's options.
No runtime change was needed.
