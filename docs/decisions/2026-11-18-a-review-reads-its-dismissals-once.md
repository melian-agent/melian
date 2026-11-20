# A review reads its dismissals once

Amends: [the dismissal record decision](2026-11-16-a-dismissal-record-holds-what-melian-dismiss-stored.md), "the same review asks the verifier again", for a dismissal replaced during the final judgement

Status: for [issue #481](https://github.com/melian-agent/melian/issues/481). The maintainer ruled on 2026-11-18, in the coordinator's session, [recorded on that issue](https://github.com/melian-agent/melian/issues/481#issuecomment-6966926120). It narrows [the maintainer's ruling of 2026-11-16](https://github.com/melian-agent/melian/issues/481#issuecomment-6910821952).

## Problem

The ruling of 2026-11-16 says a dismissal replaced while a review runs is another verification request, so the same review asks the verifier again and the restatement carries the dismissal that stands. The review keeps that promise only when the replacement lands while an earlier verification wave judges. The final step then reads the candidates again, sees the new dismissal, and asks again.

The final step reads the roots' dismissals once, when it forms its candidates, and nothing reads them again before its verification task ends. A replacement that lands in that window is never asked about.

Example: `packages/pipeline/test/restatement.test.ts` replaced the root's dismissal during the verifier's first judgement and expected two. When both lenses ended before any wave started, the final step made the only judgement, and the test failed with `expected 1 to be 2`, about one run in three under load. Holding the wave back 500 ms made it fail every time.

## Decision

A review reads its inputs once. A dismissal replaced during the final judgement is picked up by the next review. This review shows the restated claim for attention: it records no restatement link, carries no dismissal, and `verdict.dismissed` holds nothing for it. It carries no out-of-date dismissal either, since a link binds only the dismissal the verifier was shown. No loop re-reads the dismissals after the final judgement.

A replacement while an earlier wave judges still gets a second judgement in the same review, and the restatement carries the new dismissal, as the ruling of 2026-11-16 says.

## Why

A loop that verified again until the dismissals stopped changing would need a bound, since a maintainer can keep replacing them, and past the bound it would end where this review ends now. The next review asks the verifier again in any case, because the replaced dismissal's record ID changes the verification request's key.

## Tests

`restatement.test.ts` pins both cases. One test ends the contracts lens only after the wave's judgement has its replacement, so the final step always follows the wave. The other turns waves off, so the final step makes the only judgement. Removing either ordering fails its test three runs in three.
