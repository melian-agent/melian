# Retire the legacy fingerprints

Amends: [2026-10-16-resolution-fingerprint-holds-resolution-only.md](2026-10-16-resolution-fingerprint-holds-resolution-only.md), the `legacyFingerprint` clause.

Problem: two fingerprints kept reading what builds before an upgrade had stored. The adjudication task accepted the policy fingerprint the first recipe gives, so a review stored before the `2:` recipe could still decide a dismissal. The publish task accepted `Verdict.legacyFingerprint()`, so a head published before evidence became a list took no second review. The first recipe hashes every built-in lens variant by version. Every built-in lens edit changes its value, and no stored input holds the old versions to compute it again. On [pull request #195](https://github.com/melian-agent/melian/pull/195) a one-sentence edit to the design lens broke its fixture, as two earlier lens edits had.

Choice: retire both, on the maintainer's ruling of 2026-10-24. They protect only stores written before failure scenarios existed. No `@melian-agent` package has been published, so such stores exist only on the maintainers' own machines, and the amended decision already said to drop `legacyFingerprint` once no stored review predates the change.

The adjudication task now accepts only the current fingerprint, so a review stored before the `2:` recipe refuses a dismissal until it is reviewed again. The publish task matches a posted record by the verdict's current fingerprint alone. A record that names no revision still counts only while no other revision of the head has a verdict with that fingerprint.

The accepted cost: a very old stored review that is published again may post a second review of the same findings.
