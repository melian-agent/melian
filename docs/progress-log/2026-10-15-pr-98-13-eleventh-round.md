[Pull request #98](https://github.com/melian-agent/melian/pull/98): fixes from Melian's eleventh round (3,929 seconds of wall time).

- c7c8828c5a29c98d: mutants that start on one changed line but end on different lines got different snippets, so different IDs, and separate findings. That broke the decision's rule of one finding per line. Every mutant that starts on a line now takes the widest span among them, so they merge. The two mutations, each mutant's own end and the narrowest span, each fail a test.
- fa0385852c4f5952: a tsc check whose base tracks `node_modules` records the base's note, so dropping a ran base's notes fails a test.
