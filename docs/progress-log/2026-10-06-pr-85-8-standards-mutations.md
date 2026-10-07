# Guard standards imports and bounds with mutation tests

[Pull request #85](https://github.com/melian-agent/melian/pull/85), fifth fix pass, finding 337745dd55b5bcfd.

Both sources now have mixed-case credential-import fixtures, including nested paths. They assert refusal before readText and absence of the generated credential contents. Removing the credential-name regexp's i flag passed all existing core tests. The new fixtures failed for both sources; restoring the flag passed them.

A sweep of standards.ts and source.ts found 25 further gaps through surviving mutations against the full core suites. New regressions cover absolute imports, empty and fenced carriers, error propagation, directory chains, empty readings, standards trust, inventory races, bounded notes, exact chain and union limits, duplicate byte accounting, and signalled ignore commands. Targeted mutation runs prove each regression fails before the source is restored. UTF-8 reader tests strengthen file bounds the existing suite already guarded.

Five probe groups concern unreachable defences. The source lookup loop returns from its final component. StandardsLoader.findPaths has no caller. Real source listings never repeat a carrier, so the expanded-file guard cannot fire. Standards maps are initialised before use, and forFiles validates requests before reading them, so their fallback arms cannot run. The exact-parent guard cannot fire: import tokens strip trailing full stops, while a parent path ending in a slash reaches the adjacent prefix guard. These probes pass after mutation; the defences remain unchanged.

V8 branch coverage identifies unexecuted blocks but cannot prove a regexp flag or an exact bound. Pair it with a mutation that removes the flag or shifts the bound by one. The sweep's catalogue, logs and adjudication remain under tmp.
