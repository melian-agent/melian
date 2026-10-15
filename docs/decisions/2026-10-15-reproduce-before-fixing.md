# A fix for a reported defect starts with a failing test

Problem: a fix pass writes its test after the fix, and the test can pass whether or not the fix is there. The mutation rule catches that later, a round or a review after the pass, and only for the guards it reaches.

Example: on [pull request #98](https://github.com/melian-agent/melian/pull/98), a fix made the triage gate's test read its baseline from `HEAD`, so once committed it passed whatever the code did, and round eleven found it vacuous. On [pull request #114](https://github.com/melian-agent/melian/pull/114), every test of the live runner's new output code passed its own environment, so replacing the code's default still passed, and the next round found it.

Choice: a fix for a reported defect, whether a review finding, a failing run, or a user's report, starts with a test built from the defect's failure scenario. It runs against the current head and fails for the reported reason, not for a typo or a missing import. Then the fix lands and the test passes. The report records both runs, the failing output and the passing one. A finding no test can reproduce, such as a race that needs a real kill or a provider's behaviour, is named in the report with the reason and what stands in for the test. The maintainer added the rule on 2026-10-15; `AGENTS.md` states it under Validation and in Briefs.

Why both rules: [the mutation rule](2026-10-07-tested-means-a-failing-mutation.md) proves after the fact that new code is tested. Reproducing first proves that the test is about the reported defect, and that the defect was real at that head.

What this gives up: a fix pass runs each new test twice, and a report grows by two outputs per finding.
