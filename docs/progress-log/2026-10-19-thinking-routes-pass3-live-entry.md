# Thinking routes: live entry mutation coverage

[Pull request #157](https://github.com/melian-agent/melian/pull/157) now imports the live entry through Vitest with credential discovery and verifier execution replaced by fakes.
Two direct tests cover parsing thinking, passing the verifier callback's complete mode, and reporting an invalid override before credentials open.
`vi.importActual` executes the entry again after resetting Vitest's module cache.
No provider or credential file is read.

Both tests pass. Each of the five exact host mutants fails: deleting parsing, deleting the catch block, deleting its diagnostic, deleting its exit, and replacing the verifier mode with an empty object.
Each mutation was restored before the next run.
The main checkout's pass 3 report and mutation inventory retain every run's output.

No production behaviour changes. The implementation plan's status stays unchanged.
