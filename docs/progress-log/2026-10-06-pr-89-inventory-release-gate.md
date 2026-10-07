# Prove the release gate entry point

[Pull request #89](https://github.com/melian-agent/melian/pull/89) now runs the release gate in a child process with injected metadata. It checks old, excepted and quarantined releases, then invalid manifest input. Every fetch is a fixture.

All 15 script and fixture mutations fail tests. The restored six-test suite passes. The offline fixture now asserts the network refusal, rather than accepting any one-element failure list.
