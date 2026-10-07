# Cache crash cleanup

Addressed Claude L12 for [pull request #89](https://github.com/melian-agent/melian/pull/89). All three caches sweep process-owned scratch on open. A killed child test proves live retention then next-open removal, including rejected graphs and coverage files. Tests also preserve published entries, recent legacy files and symlink targets.
