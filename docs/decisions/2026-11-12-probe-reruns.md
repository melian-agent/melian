# Probe reruns: once a probe, conclusive runs only

Amends: [A trust-boundary level that probes](2026-11-07-trust-boundary-level-that-probes.md), the verifier's reruns
Amends: [Probing holds to fixed limits](2026-11-09-probing-fixed-limits.md), the reruns

Status: ruled by the maintainer in the builder's session for [pull request #296](https://github.com/melian-agent/melian/pull/296): the rerun key and answered attacks on 2026-11-10, the stored reruns and host inputs on 2026-11-12.

Problem: before verification, the review runs each claim's probe again and stores the run. Codex's adversarial review found that the rerun was keyed by its claim. A prober that cited one failed probe in many findings had Melian write the head and run that probe once for each, bounded only by the findings budget, not by the fixed limit of 48 probes. The Actions round at `aa6ca16a` found that a stored rerun stood for every repeat review of its head, even under `--rerun`. A rerun that timed out under load therefore kept its claim from ever being confirmed.

Choice:

- A rerun is keyed by its claim's lens run and the probe's ID, so every claim that cites one probe shares its rerun, and a run's reruns stay within its 48 probes.
- A stored rerun that failed or passed stands for every repeat review of its head. One that timed out, was cut or ended by a signal runs again on a repeat review, as a refused one does, since its cause may have passed.
- A probe reads the checkout's `node_modules` and the base policy's `probe.read` files as they stand on the host when it runs. The attach key names those paths, not their contents.
- An attack counts as answered once a probe ran for it, whatever the probe showed, or once the prober skipped it with a reason.

What it gives up:

- A repeat review after a reinstall, or after an allowlisted file changed, reuses the probing runs and conclusive reruns of the first. Hashing the granted inputs into the key would cost seconds to minutes on each review.
- A prober whose only probe of an attack timed out, was cut, or failed without a finding leaves the lens recording `ran`. Its record says how many probes ran, and the prober is told an inconclusive probe shows nothing; a failure the prober judges spurious is its call, as a skip is.
