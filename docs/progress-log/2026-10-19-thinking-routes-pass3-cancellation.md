# Thinking routes: omitted cancellation option

[Pull request #157](https://github.com/melian-agent/melian/pull/157) now checks the model collection's completion options directly when triage receives no cancellation signal.
The existing test checked only the provider's signal value, which could not distinguish an absent property from `signal: undefined`.

The three direct model tests pass after restoring the source.
The exact Stryker replacement of `signal === undefined` with `false` fails the new property assertion.
The main checkout's pass 3 report and mutation inventory retain the failing run.
No production behaviour changes. The implementation plan's status stays unchanged.
