# Comparison prints its generated output and writes no file by default

Choice: `melian compare backlog --markdown` prints the generated section for BACKLOG.md and never writes the file. `melian compare export` prints to standard output, and `--out` is its only file write.

Why: A command that rewrites a tracked file from stored state edits the maintainer's working tree without being asked, and the frozen hand-kept entries sit in the same file. Printing lets the maintainer review the section and paste it. Stats, backlog, and export already read storage without a harness or a durable commit; writing a file would be their one side effect outside storage.

Supersedes: [2026-10-05-comparison-as-a-capability.md](2026-10-05-comparison-as-a-capability.md), for the plan's and design's earlier wording that the backlog command writes BACKLOG.md's later section.
