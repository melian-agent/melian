# Contributing to Melian

Melian is in its first milestone and the foundations are still moving. Contributions are welcome once they settle; until then, open an issue to discuss before writing code.

## The bar

The same as Pi's: you must understand the code you submit. Using an agent to write it is fine. Submitting what you cannot explain is not. Read [AGENTS.md](AGENTS.md) for the conventions and [docs/design.md](docs/design.md) for the decisions.

## Reviews

Every pull request is reviewed by Melian itself, and for now also by other reviewers for comparison. Until container isolation exists, Melian reviews pull requests from maintainers only. Pull requests from other contributors are reviewed by a maintainer first.

## Process

One pull request per issue. Stack commits inside it. `npm run check` must pass, and `main` is protected: nothing lands without the check and a pull request.
