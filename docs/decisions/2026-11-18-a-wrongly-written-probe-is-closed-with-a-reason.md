# A wrongly written probe is closed with a reason

Amends: [A failed probe needs a finding](2026-11-17-a-failed-probe-needs-a-finding.md), probes that never exercised their attack

Status: ruled by the maintainer on 2026-11-18, in [a comment on pull request #532](https://github.com/melian-agent/melian/pull/532#issuecomment-6964725749). The coordinator chose the mechanism the same day. The builder's choices below are marked as the builder's.

Problem: since the decision of 2026-11-17, an attack with a failed probe is answered only by a finding resting on that probe. A probe can fail for a reason of its own. Example: the prober writes a probe with a wrong import path, and it exits 1 with `ERR_MODULE_NOT_FOUND`. A corrected probe then passes, but attack 2 stays unanswered. The prober's only way out is a finding on the broken probe. The verifier rightly refutes it, and the trust floor holds the refuted claim at acknowledgement, so a maintainer must dismiss a finding the pipeline forced. Without that finding the lens ends and the round reads not reviewed.

Choice:

- The prober may close a failed probe that never exercised its attack. It calls `skip_attack` with the attack, the probe's ID as `probe`, and the reason the probe never exercised the attack. An attack whose every failed probe is closed is answered.
- Melian stores the reason and shows it with the lens's result, in the probing note on its check record: `closed attack 1 with no finding, since probe p1 never exercised it: "<reason>"`. A verdict's reader meets it there, not only in telemetry.
- `skip_attack` refuses to close a probe that did not run in the prober's conversation, that probed another attack, or that did not fail. Its schema refuses a blank reason.
- The trust floor is unchanged. A finding the prober reports on a failed probe is handled as before.
- The builder chose these:
  - Closing one failed probe leaves the attack unanswered while another failed probe of it stands, so a prober cannot close the probe that showed the defect by closing a broken one beside it.
  - `closed` is an optional field of `ProbingDocument`, keyed by probe ID, and the document keeps version 3. A build that does not know the field reads a closed attack as unanswered and ends the lens, which fails closed.
  - When a lens ends both with an unanswered attack and its findings budget spent, its record names both, so a reader sees that the budget may explain the missing finding.

What it gives up: a prober can close a probe that did show the defect, by claiming it was written wrongly. The reason stands in the verdict for a reader to judge, and no verifier checks it. Changing `skip_attack`'s schema and description, and the prober's wording, changes every probing run's request key, so each such run asks its model again once.
