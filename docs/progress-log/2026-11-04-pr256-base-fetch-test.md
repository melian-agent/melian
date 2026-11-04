# Test that membership fetches a remote-only pull request base

For [pull request #256](https://github.com/melian-agent/melian/pull/256), finding `f59e831126ed834d`, one regression test now pins the fetch of the pull request's current base. The parent is `f086a12d2b76b4b5ffe8e675350abb5f5f34a949`. No production code, decision, schema or guideline changed.

## The gap

This is a test gap, not a production defect. `PullRequestMembership.classify` already fetches the candidate head, the candidate base and the pull request base before it reads merge bases. Dropping `this.base` from that loop, `[candidate.head, candidate.base, this.base]` to `[candidate.head, candidate.base]`, passed all 18 existing tests in the three membership files.

Every existing missing-object test brings the base along. Either the base is already local, or the commit under test has the base as its parent on the remote. None has a current base that exists only on the remote and diverges from the head.

## The test

`fetches a remote-only pull request base that diverges from the head before reading merge bases` uses the existing local repository and bare origin. The stored base B and the head H are local. The pull request base T is a child of B that exists only in the bare origin. The answer names T as its base, and the candidate names B and H.

The test checks that T is absent locally before classification. It then expects the whole `member` result, with the date read from Git, and checks that T is present locally afterwards.

## Failing before, passing after

This is the test-defect exception to the failing-test-first rule. The correct head has no failing run to reproduce, so the evidence is a survivor before and a kill after. Scratch scripts and results are in `tmp/pr256-base-fetch-test/`. Every run used Node 24.18.0, Vitest 5.0.3 and `--maxWorkers=2`.

| Source | Tests | Exit | Result |
| --- | --- | --- | --- |
| Original source, original three files | 18 | 0 | 18 passed |
| Variant source, original three files | 18 | 0 | 18 passed: the variant survives |
| Original source, new fetch file | 5 | 0 | 5 passed |
| Variant source, new fetch file | 5 | 1 | New test failed: `foreign`, "head has no merge base with the pull request base", where `member` was expected |
| Restored source, all three files | 19 | 0 | 19 passed |

The variant source hash was `6dbdf21c65b4e002957e297c55a3361d9860c1dd702b07faf188dd21e67907e7`, and the original and restored source hash was `7c9d6332e8acd3abe68c144e73b9ba8d9a47c68e15abb87a343f3f9b78309af9`. The script confirmed the one line occurred once, and restored the file byte for byte in a `finally` block. The native probe's run showed the same variant surviving the 18 core tests and the 307 wider tests. Those numbers are partial proof data from outside this change.

## Mutation inventory

Enumeration ran first, from the parent to scratch snapshot `3f4d46f05e2952ccc707731a532146b6a14bca69`, with `--limit 10000`. The snapshot holds the two changed paths, including this entry before it was tracked. The change has no production source, so the output listed 0 mutants, 0 omitted and 0 unmutated. The supplemental drop-`this.base` variant is outside that generated inventory. It is a hand-written proof of this test gap, not a generated row.

## Whole gate

`npm run check` ran on the host, on Node 24.18.0 and npm 11.19.0 through `npx`, with `VITEST_MAX_WORKERS=4`. It exited 0 with 7,193 passed and 2 skipped across 222 files. It took 497.65 seconds wall and 486.90 seconds in Vitest. The receipt is `tmp/pr256-base-fetch-test/gate-receipt.json`.

The production source, the test file and a draft of this entry had the same hashes before and after the run. The gate covered those bytes. I added this section after the gate, so the gate did not run on the final prose. It is not a run of a committed head.

## What this does not cover

It claims no proof against a live GitHub run. It changes no decision or plan status. Fresh final-head reviews and CI on the pushed head are still to do.
