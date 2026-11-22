# Issue 617, pull request B: a size past the entry limit reads no sizes

Builder agent: this pass fixes round 1's acknowledge finding `56e1c2430d6966ad` on [pull request #645](https://github.com/melian-agent/melian/pull/645). It follows the coordinator's direction, option A.

The finding: past the entry limit, a read refuses before it reads a size, but `StateTree.size` still read the size of every blob. A tip past the entry limit is the tip `melian records size` exists to describe, and the work it did there grew with the tip.

Now `size` stops past 65,536 entries, as a read does. It counts the entries and the listing's bytes, says record bytes are not counted, and still warns:

```
melian/state: 65,537 of 65,536 entries, record bytes not counted past the entry limit, listing 4 MiB of 64 MiB
```

Its JSON holds `entries` and `listingBytes` alone. `TipSize.parse` reads that shape only for more than 65,536 entries, so a count under the limit with no record bytes is still refused.

The same pass fixes the rounding the review of record noted. A held size one byte past 256 MiB printed as "256 MiB of 256 MiB", which reads as at the limit. A count past its limit now prints as "over 256 MiB of 256 MiB", for record bytes and listing bytes alike.

Failing tests first, run at `837ea54ce`:

- "counts a tip one entry past its limit, which every read refuses, and reads no sizes, as a read reads none" failed with `expected "sizes" to not be called at all, but actually been called 1 times`.
- "prints a count past its limit as over the limit, never as at it" failed with `Received: "melian/state: 65,536 of 65,536 entries, 256 MiB of 256 MiB, listing 64 MiB of 64 MiB"`.

Both pass after the fix. "reads the sizes of a tip at exactly its entry limit" holds the bound from the other side, and three tests that read `counted?.recordBytes` now read the JSON, so the uncounted shape fails them.

Mutants: the enumerator listed 49 over `837ea54ce...HEAD`, none omitted. Each ran by hand against its named test alone, and [the inventory](2026-11-22-issue-617-size-uncounted-mutants.json) records each. That includes the 15 string literals the configuration ignores. 48 were killed by the tests above. One survived the first run: the error message of `TipSize.pastEntryLimit`, which the test asserted only threw. The test now asserts the message, and the mutant fails it.
