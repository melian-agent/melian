# Make the refused-read doctor test depend on the unknown-permission branch

The refused viewer and permission cases in `packages/cli/test/doctor.test.ts` ran with `trust: { writers: false }` on `origin/main`, so the trust line was `warn` before any GitHub read. Deleting `state = "warn"` from the `permission === undefined` branch of `packages/cli/src/doctor.ts` left both cases green. They now commit `trust: { writers: true }` first, as the permission matrix does, so only the unknown-permission branch can produce `warn`. With the line deleted they fail; restored, they pass.
