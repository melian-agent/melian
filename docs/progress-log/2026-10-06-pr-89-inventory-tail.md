# Allow release-gate subprocess time under load

For [pull request #89](https://github.com/melian-agent/melian/pull/89), the release-gate test now allows 60 seconds. Its injected metadata and subprocess assertions remain intact. The focused suite passes all six tests.

The continuation reconstructs the local inventory from committed tests and saved proof results: 600 rows, 445 already killed, including 111 from earlier passes. It does not rerun proven mutations.
