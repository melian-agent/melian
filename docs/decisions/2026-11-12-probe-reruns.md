# Probe reruns: once a probe, conclusive runs only

Amends: [A trust-boundary level that probes](2026-11-07-trust-boundary-level-that-probes.md), the verifier's reruns
Amends: [Probing holds to fixed limits](2026-11-09-probing-fixed-limits.md), the reruns

Status: ruled by the maintainer in the builder's session for [pull request #296](https://github.com/melian-agent/melian/pull/296): the rerun key and answered attacks on 2026-11-10, the stored reruns, host inputs and the rerun task on 2026-11-12.

Problem: before verification, the review runs each claim's probe again and stores the run. Codex's adversarial review found that the rerun was keyed by its claim. A prober that cited one failed probe in many findings had Melian write the head and run that probe once for each, bounded only by the findings budget, not by the fixed limit of 48 probes. The Actions round at `aa6ca16a` found that a stored rerun stood for every repeat review of its head, even under `--rerun`. A rerun that timed out under load therefore kept its claim from ever being confirmed.

Choice:

- A rerun is keyed by its claim's lens run and the probe's ID, so every claim that cites one probe shares its rerun, and a run's reruns stay within its 48 probes.
- A revision's reruns run in a durable task, `melian.probe-reruns`, which the reruns document names as the revision's owner. A second review whose claims rest on the same probes attaches to the live task and waits on it, as it would a lens task. A review whose claims rest on other probes takes the revision over, and the task it replaced writes and prunes nothing more. A review takes the reruns over only while the review index still names its lens task, so one another review has replaced cannot take them back, by the maintainer's ruling of 2026-11-13. The verification after it checks the lens selection, not the task, which [issue #381](https://github.com/melian-agent/melian/issues/381) tracks. The maintainer ruled on that on 2026-11-12, after Codex's review found two concurrent reviews running one rerun twice, and one's cleanup deleting the other's runs.
- A stored rerun that failed or passed stands for every repeat review of its head. One that timed out, was cut or ended by a signal runs again on a repeat review, as a refused one does, since its cause may have passed.
- A probe reads the checkout's `node_modules` and the base policy's `probe.read` files as they stand on the host when it runs, under the host's sandbox. The attach key names those paths, not their contents. It names the host the probes run on, as the attach-key decision says.
- An attack counts as answered once a probe ran for it, whatever the probe showed, or once the prober skipped it with a reason.

What it gives up:

- A repeat review after a reinstall, or after an allowlisted file changed, reuses the probing runs and conclusive reruns of the first. Hashing the granted inputs into the key would cost seconds to minutes on each review.
- A prober whose only probe of an attack timed out, was cut, or failed without a finding leaves the lens recording `ran`. Its record says how many probes ran, and the prober is told an inconclusive probe shows nothing; a failure the prober judges spurious is its call, as a skip is.
