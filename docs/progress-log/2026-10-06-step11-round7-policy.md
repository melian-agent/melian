# Step 11: trusted Enola policy after the merge

Confirmed finding 24e2f5b6af2f0b38 from [pull request #89](https://github.com/melian-agent/melian/pull/89). Enola read the diff’s merge base while the review named the target tip as policy authority. This was stale policy, rather than policy controlled by the head.

Checks now pass the trusted revision source separately from the comparison base. Caller queries use that same source and graph key. Local worktree reviews retain base policy. The regression branches before a target constraint, introduces a breach, and checks the finding, baseline commits, policy cache keys and caller reuse. CLI tests cover committed and local policy sources. This restores the existing host-policy contract.
