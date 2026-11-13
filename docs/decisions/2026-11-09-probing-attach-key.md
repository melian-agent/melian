# A probing run's attach key holds its whole environment, and no moving context

Amends: [A trust-boundary level that probes](2026-11-07-trust-boundary-level-that-probes.md), the lens task's attach key

Status: ruled by the maintainer, 2026-11-09, in the builder's session for [pull request #296](https://github.com/melian-agent/melian/pull/296).

Problem: the lens task's attach key drew a new finding in five fix passes running. The last two came from the Actions round at `00804e57`. A run a quick level escalates to added no probing environment to the key, so a changed `probe.read` reused the old run. And the planner's earlier findings sat inside the instruction fingerprint. Re-reviewing the same head after a dismissal, or after another revision, therefore missed its attach and ran every lens again, though the review-attachment decision says a repeat call attaches. The same code could show a later revision's findings to the planner as the earlier revision's.

Choice: every run's selection, the first and the one a quick run escalates to, names its whole probing environment as one JSON value, so any change to its writer, the policy's word, its time limit or its grant runs it again. The planner's decisions at base and its earlier findings leave the instruction fingerprint, as the caller-context decision kept caller context out, and stay in the prompt. The fingerprint holds the probing protocol as the build renders it, so a Melian release that changes it runs the level again: each role tool's name, description and schema, the fixed limits, and every fixed prompt, the planner's role among them, with fixed arguments. The maintainer ruled on that on 2026-11-12, after two rounds running found fixed probing input outside the key. Its earlier findings come from the revision reviewed before this one, never one reviewed after it.

What it gives up: a repeat review of a head plans from the decisions and findings its first run read, not from those the head's base and history hold now, until something in its key changes.
