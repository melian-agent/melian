# One file per log entry

Choice: The decision log and the progress log are directories with one file per entry

Why: Parallel pull requests must not conflict on bookkeeping, and GitHub ignores git merge drivers such as `union`
