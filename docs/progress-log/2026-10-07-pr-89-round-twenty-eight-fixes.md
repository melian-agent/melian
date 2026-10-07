# Pull request 89, round twenty-eight fixes

Two findings. Commit c32aef00 derives the caller notes and coverage a review records from the lens task's stored input, so a repeat call that finishes a crashed first call's task records what the lens read; the decision file for caller context extends to cover it. The second commit ranks `EnolaRun.callers` so code files spend the 128-query cap before documents and data files, and names the first five unqueried files in the omission note; the guideline in `docs/guidelines/pipeline.md` says so.
