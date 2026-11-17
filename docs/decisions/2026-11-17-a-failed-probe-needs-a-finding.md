# A failed probe needs a finding

Amends: [An attack needs a probe that shows something](2026-11-16-an-attack-needs-a-probe-that-shows-something.md), answered attacks

Status: ruled by the maintainer on 2026-11-17, relayed by the coordinator and recorded on [pull request #532](https://github.com/melian-agent/melian/pull/532). The builder's choices below are marked as the builder's.

Problem: a probe that fails has shown the defect its attack aims at, yet the attack counted as answered whether or not the prober reported it. Example: Codex's second adversarial review of pull request #532 had a prober run a probe for attack 1 that exited 1, then answer "Reported 0 findings." The lens recorded `ran` with no finding, and the round read clean though its own probe had shown a defect.

Choice:

- An attack with a probe that failed, one that ran to its end within its limits and exited non-zero but not 125, is answered only once a finding the prober reported rests on one of that attack's failed probes. A skip does not answer it, nor does a probe of it that passed.
- Otherwise the prober gets the existing one-time reminder. If it still reports nothing, the attack is unanswered and the lens ends, so the round reads not reviewed.
- An attack with no failed probe is answered as before: by a probe that showed something, or by a skip with its reason.
- A finding the verifier later refutes still answers the attack. The rule asks whether the prober reported what its probe showed, not whether the verifier agreed. The verifier's judgement then decides what the finding requires, as for any finding.
- The builder chose these:
  - One finding resting on any failed probe of an attack answers it, since several probes of one attack usually show one defect.
  - The reminder and the lens record each use one sentence for both kinds of unanswered attack, "no finding on a probe that failed, nor a probe that passed or a skip", so the lens task's stored outcome keeps its shape.
  - `report_finding` records, in the prober's `ProbingDocument`, each attack a finding answered, in `answered`. Two attacks that fail on one defect report one finding ID, so the finding answers both.
  - A finding rests on the probe that first showed it, and its verifier runs that probe again, as main does for every finding: one finding, one probe. A later report of the same ID on another probe answers that probe's attack and leaves the stored probe alone. Keeping every probe a finding rests on, and showing each to the verifier, is [issue #545](https://github.com/melian-agent/melian/issues/545).

What it gives up: a probe that fails for a reason other than the defect, such as a typo in the probe, now costs the prober a finding or its lens. The prober can still run another probe, but no later probe answers the attack once one has failed. The tests lens gains most: a test that already failed before the change now has to be reported, where before it could be skipped.
