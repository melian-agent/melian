# The criterion for retiring shadow reviewers

Supersedes: none.

The maintainer chose recall of at least 0.75 against the shadows' adjudicated findings. The window covers the ten most recent pull requests with a comparison record. The committed root `melian.yaml` stores `comparison: { retirement: { pullRequests: 10, recall: 0.75 } }`.

The window counts pull requests, not review rounds. Recall counts valid, in-scope distinct findings across both shadows, counting a finding once. Noise, duplicates and out-of-scope findings do not enter the denominator. Pending adjudications are never guessed. Absent records are excluded, and fewer than ten records keep the shadows running.

Only the maintainer may tighten the criterion. Every difference is still adjudicated. This records a retirement criterion; it does not retire either reviewer or claim that Melian meets it.

The retirement line in `melian compare stats` is a follow-up to [pull request #72](https://github.com/melian-agent/melian/pull/72), which has not landed.
