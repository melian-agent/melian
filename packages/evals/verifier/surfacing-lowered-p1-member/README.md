# surfacing-lowered-p1-member

Source: [the decision](../../../../docs/decisions/2026-10-13-re-scope-held-for-the-compiler.md), Goldens, surfacing: a pre-existing P1 that the verifier lowered to P2 is still a member.

The lens reports a P1 on the untouched read, which location classifies `pre-existing`. The verifier lowers it to P2. Membership reads the lens's severity, before any lowering, so the finding is still listed under "Pre-existing, important".

Scripted only. The finder and the verifier are both the fake model, so the golden tests what Melian does with the report, never what a model says.
