# Melian progress log

What landed against the [implementation plan](../design-implementation-plan.md), one file per entry. The directory listing in name order is the log, oldest first.

A new entry is a new file, so two pull requests that each add one never touch the same lines and never conflict. Never edit another entry's file; if an entry turns out wrong, add one that corrects it.

Name a file `YYYY-MM-DD-<slug>.md`, dated the day the work landed or opened. Start the slug with the pull request, as `pr-23-decisions-fast-default`, so entries on one date sort by pull request. When one pull request has several entries, number them after it, as `pr-15-1-lenses` and `pr-15-2-claude-code-oauth-token`, so they sort in the order they happened.

The file holds the entry as one paragraph: what changed and why, with a link to the pull request and to anything it records. Links are relative to this directory, so the design is `../design.md`.
