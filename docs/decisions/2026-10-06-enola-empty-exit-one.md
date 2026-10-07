# Empty SARIF on exit one

A valid SARIF report is the authority for Enola findings. Exit 1 with no unsuppressed results remains a clean run, but its check record now says so. It can follow filtering of resolved or suppressed results. Inventing a failure from the exit would contradict the report and turn that filtering into a failed review. Missing, malformed or unsupported SARIF and exits other than 0 or 1 still fail.
