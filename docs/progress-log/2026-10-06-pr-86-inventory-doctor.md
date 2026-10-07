# Prove doctor’s trust paths

[Pull request #86](https://github.com/melian-agent/melian/pull/86)’s inventory adds assertions for absent repositories, refs, tokens and origins; escaped policy errors and viewer text; the default transport; timer cleanup; and both abort signals. A trusted HEAD fixture prevents the trust warning hiding the unknown-base warning.

All transport tests stub the global fetch as well as using injected fakes. A mutation that bypasses injection therefore cannot reach GitHub. Source mutations must fail a passing baseline, including the unknown-login label.
