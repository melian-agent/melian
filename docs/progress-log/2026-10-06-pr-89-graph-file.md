# Graph corruption repairs

Confirmed Claude L6 for [pull request #89](https://github.com/melian-agent/melian/pull/89). A regular file at the entry path produced ENOTDIR. Publication now moves that corrupt entry aside and retries, as for corrupt directories. The regression failed before the fix.
