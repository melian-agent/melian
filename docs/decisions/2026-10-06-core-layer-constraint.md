# Enola’s core layering constraint

Declare core imports as dependency facts under packages/core and forbid both named pipeline-package imports and resolved imports into packages/pipeline. The default directory-only rule cannot resolve workspace aliases: the scratch @melian-agent/pipeline import produced only a skipped-target advisory, and check exited clean. Adding alias globs did not fix grounding.

Upstream’s named-target form takes a list of exact literals or bounded prefixes. The committed rule names the bare package and its slash-prefixed subpaths. The directory rule covers resolved relative paths. This uses the upstream evaluator rather than rebuilding alias resolution.

On the ad303b5 tree with this policy, constraints lint resolved 41 core-import dependency facts and 514 pipeline members. The clean check exited 0 with no SARIF results. A tracked scratch file importing the package, its testing entry and a relative pipeline source produced three errors at lines 1–3 and exit 1.

The harness-free test stays. It forbids every Pi or Melian package import, covers more syntax and does not depend on the graph. Enola adds an independently exercised architectural rule but is not a replacement.
