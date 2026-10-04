# conventions-bare-reference

Seeded from finding 7 of the [comparison record](../../comparisons/2026-10-03-pr-10.md) for [pull request #10](https://github.com/melian-agent/melian/pull/10): the progress-log entry lacked links to the pull request and the issues. The change it documents, `count`, is the number of lines a receipt lists and never reads a price: an earlier version counted only items priced above zero, and since the golden's design lets a price hold a fraction of a cent that rounds, an item at 0.4 cents was a real defect `correctness` rightly reported.
