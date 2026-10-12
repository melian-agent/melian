# Sandbox reads only the Node runtime

Supersedes: none.

Problem: granting Node’s entire prefix exposes home when Node sits at home/bin/node. It also exposes shared files under /usr/local.

Choice: grant the canonical executable as a literal path. A prefix belongs to Node only when the executable is prefix/bin/node and the prefix is a directory. Exclude home, every ancestor of home, /, /usr, /usr/local and home/.local. Grant only existing, canonical directories at lib/node_modules and include/node. No directory grant follows a symlink.

Seatbelt and bubblewrap use the same rule. Linux binds named system runtime directories instead of all /usr, which would expose /usr/local again. A confined Node startup probe skips with noSandbox on failure and records the reason. It never widens a grant.

Fakes cover each layout and exclusion. A host seatbelt probe copies Node into a home-shaped prefix and proves that a file beside bin stays unreadable. The profile-balance test runs without a sandbox.

[Pull request #98](https://github.com/melian-agent/melian/pull/98) narrows these runtime reads.
