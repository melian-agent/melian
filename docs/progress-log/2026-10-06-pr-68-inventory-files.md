# File importer mutation inventory

For [pull request #68](https://github.com/melian-agent/melian/pull/68), inverted file-import guards and removed read-error and path fallbacks. Replacing the repository-root fallback passed existing tests. A new test rejects that realpath call and asserts the repository-relative source. It fails the mutation; all 19 pipeline comparison tests pass after restoration. The earlier exact-limit size mutation remains proved by round fourteen. No design decision changed.
