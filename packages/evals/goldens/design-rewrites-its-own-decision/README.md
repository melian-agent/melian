# design-rewrites-its-own-decision

Written for the fix pass on [pull request #93](https://github.com/melian-agent/melian/pull/93), from Melian's own review of the design lens, which read decisions at the head and excused a departure when the same change edited the decision file. The head makes an omitted writer-trust argument default to trusted and rewrites the decision file to say so. The lens must judge the change against the base text and report it, naming the base decision it quotes.
