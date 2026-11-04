Fix pass 4 for [pull request #217](https://github.com/melian-agent/melian/pull/217) restores the Reach line when an older build left a publication pending. The post site now reads that round's saved verdict through `verdictWithLegacyCaveats`. `PublishedDocument` stays at version 9.

The regression reuses the pre-caveat verdict recorded by main at `460f68f0`. The version-9 publisher writes a refused round from that verdict. The test restores the upgraded live verdict, closes SQLite, then retries through `openPublishHarness`. It asserts that the recorded review request contains the Reach line and that only one review posts.

At `f027a91d`, the test failed because the posted body lacked Reach. With fix commit `8fc92709`, all 42 tests in the pending-caveat, caveats-reopen and publish-rounds files pass. Type checking and Biome pass. Removing the helper restores the missing-Reach failure in `legacy-pending-caveats.test.ts`.

Enumeration over this pass's commits, `f027a91d...HEAD`, lists zero generated mutants and zero omissions. The scratch inventory also records the killed helper-bypass probe and its named test file. The full gate was not run in the sandbox; the host must run `npm run check`.
