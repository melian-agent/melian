# Sandbox reads only the Node runtime

Supersedes: none.

Problem: granting Node’s entire prefix exposes home when Node sits at home/bin/node. It also exposes shared files under /usr/local.

Choice: grant the canonical executable as a literal path, and nothing else of its prefix.

The first form of this decision also granted `lib/node_modules` and `include/node` under a prefix Node owned, for npm, npx, corepack, and node-gyp. None of them starts inside the sandbox: `bin/npm` is a link in a directory the profile does not grant, so the shell reports `npm: command not found`. A grant no program can use is only a read of the reviewer's globally installed packages, so both went, with the rule that chose them.

Seatbelt and bubblewrap use the same rule. Linux binds named system runtime directories instead of all /usr, which would expose /usr/local again. When Node cannot start inside the sandbox, a Biome or tsc run falls back to an unconfined run with its output withheld and its record saying why; a check that executes head code would be skipped. No grant is ever widened to make Node start.

A host seatbelt probe copies Node into a home-shaped prefix and proves that a file beside bin stays unreadable. The profile-balance test runs without a sandbox.

[Pull request #98](https://github.com/melian-agent/melian/pull/98) narrows these runtime reads.
