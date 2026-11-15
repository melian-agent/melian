[Issue #334](https://github.com/melian-agent/melian/issues/334) asked whether an inherited dismissal should change the verdict's fingerprint. The maintainer ruled on 2026-11-15, in the coordinator's session, for option 1: keep `Verdict.fingerprint()` as built, and record why. [The decision](../decisions/2026-11-15-inheritance-and-the-verdict-fingerprint.md) says how an inheritance already changes the fingerprint, through the finding's group, the status and a merged report's `dismissed` flag, and why a switch of root posts no review. `docs/design.md`, the pipeline guideline, the `Verdict.fingerprint` row of the identity guideline and step 41 of the plan now say the same. No code, key or stored shape changed.

`cbbb0a71` pins the behaviour with five tests. In `packages/core/test/restatement.test.ts`, under "an inheritance and the fingerprint": (a) "moves an inherited finding out of its group while another stays live, which alone changes the fingerprint" and (b) "changes the fingerprint through a merged report's dismissed flag, whichever root it inherits", each asserting both whole fingerprint values. In `packages/pipeline/test/publish.test.ts`, under "publication planning recovery > an inherited dismissal at one head": (c) "posts a review and recounts the status when one of two live findings inherits", (d) "posts a review again and fails the status again when the inheritance is revoked" and (e) "posts no review when the root switches, and names the new root in a reply, the status and the ledger".

Each test was run against seven mutations of the source at `026babda`, one at a time, with the source restored after each. A test that failed is marked killed.

| Mutation | Killed by |
| --- | --- |
| The fingerprint hashes empty groups and an empty `dismissed` list | a, b, c |
| The same, with `status` and `blocking` left out too | a, b, c, d, e |
| The fingerprint strips `dismissed` from merged reports | b |
| The fingerprint keeps `dismissal`, the root included | a, b, e |
| `dismissalVersion` leaves out `inheritedFrom` | e |
| Publication stops comparing the status description | c, e |
| The ledger's stamp ignores the projection | e |

The revocation test, d, survives the first mutation because the status flip alone posts its review; the second mutation shows it reads the status.
