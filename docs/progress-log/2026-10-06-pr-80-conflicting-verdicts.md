# Conflicting verifier verdicts

[Pull request #80](https://github.com/melian-agent/melian/pull/80) makes report_verdict sequential and keeps the strongest judgement in each claim's versioned upsert. Tests cover all six call orders, parallel commits, weaker retries and a real kill after the second conflicting call commits. Replaying that call preserves the confirmed verdict and findings version.
