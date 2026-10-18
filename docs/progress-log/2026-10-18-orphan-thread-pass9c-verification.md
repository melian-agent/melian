# Finish the recorded-publisher pass

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 9c.

The implementation landed in four pushed commits:

- `65e27cfb`: recorded publisher recovery, version-1 supersession, main-written version-8 fixture and guidance.
- `a2b6e1b4`: posted-round numbering when rebuilding a missing ledger.
- `4b0c7360`: six reopen cases from genuine version-4 to version-6 publisher output.
- `c0d069ae`: Alice-before-post, Bob-after-post and Carol recovery across two process kills.

All 339 focused tests pass. The mutation inventory records 164 hand runs: 152 killed and 12 equivalent.
It includes exact installed-Stryker replacements for the reported line-94 and line-624 survivors.
Every equivalent has a reason. Failing regressions and passing runs are retained in `tmp/orphan-thread-pass9c-report.md`.

The whole gate ran twice. The final run passed 4,880 tests, skipped 53 and failed four existing process tests.
Three failures explicitly report `ps failed: undefined`.
The supervisor-stop test returns `toolFailed` instead of `invalidOutput`; its assertion output does not establish the underlying denial.
Both runs passed formatting, type checking and the configured dependency audit threshold.
The coordinator must rerun the whole gate and cold mutation round on the unconfined host.
The pull request stays a draft.

One test lesson belongs in the guideline: a custom fetch's successful JSON response needs its JSON content type.
Without it, Octokit returns text. Missing and empty logins then exercise the same type failure.
The exact length-check mutation exposed that gap; adding the header made the empty-login test kill it.

The final gate tested runtime and test source at `c0d069ae`.
This entry and the guideline note change documentation alone.
No stored version, dependency file, comparison record or implementation-plan status changed.
