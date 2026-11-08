# Re-scoping is retired: location alone decides a finding's cause

Status: decided for [issue #228](https://github.com/melian-agent/melian/issues/228). The maintainer ruled on 2026-11-08, in the builder's session, to retire re-scoping rather than build a route for it.

Amends: [Step 17 ships lowering, and re-scoping waits for the compiler](2026-10-13-re-scope-held-for-the-compiler.md), its section "What is held, for the step that builds the route"

## Problem

Step 20 was to let the verifier propose that a finding is `pre-existing`. Melian would accept the proposal only after asking an authority four things:

- the failing lines are the base's own;
- the trigger and its path are untouched;
- no caller is new;
- no guard on the path is gone.

[Ask the authority](2026-10-12-ask-the-authority.md) requires each answer to come from a parser, compiler or analyser, never from matching names in text, and requires a check that no authority answers to refuse.

None of the four has a whole authority today:

- Enola's graph holds call and import edges, with each declaration's start line but no end. It holds no data flow and no conditions. On Melian's own code it found 50.2% of production call pairs. Its caller queries read the head alone.
- The TypeScript compiler graph, `CompilerGraph`, gives exact call pairs with spans, for TypeScript only. Only the evals run it.
- Nothing answers what triggers a failure, or which guard sits on the path to it. Nothing tells a comment edit from a code edit inside a hunk.
- Nothing traces a change in a file the compiler does not read, such as a JSON or YAML file a trigger reads.

So the rule would refuse every proposal that needs a trigger or a guard. That is the safe answer, and it leaves a route that almost never accepts.

Example: the case step 20 was to unblock is an old P1 defect in `parseRecord` that blocks because the change edited a comment on line 20 of the same function. The compiler can show that no caller of `parseRecord` is new. It can show that the function's tokens are unchanged, comments aside. It cannot show that no configuration the trigger reads has changed. The pull request also edits a progress-log entry, which the compiler never sees. A sound route refuses.

## Decision

1. The verifier never proposes a scope. Its report has no field for one, and `report_verdict` refuses a report that adds one. A finding's cause is its location's alone, as [cause by location](2026-10-03-cause-by-location.md) set it. The hold becomes the rule.
2. An old defect that blocks because of where the change touched it is answered with a dismissal. A writer records it, with a reason, through a host round. [Issue #315](https://github.com/melian-agent/melian/issues/315) carries a dismissal to a later restatement of the same defect, so a ruled defect is dismissed once.
3. The held route is withdrawn: rules (a) to (d), the thirteen goldens held with them, the second kind of member of "Pre-existing, important", a re-scoped finding, and the stronger scope an equal verdict keeps in a conflict. A member stays a finding pre-existing by location whose original severity is P0 or P1.
4. The verifier's `base` answer, whether the failure was there before the change, stays stored and changes nothing. It no longer waits for a route. A later decision may read it, for example to calibrate lenses or to rank what a maintainer dismisses.

This settles [issue #126](https://github.com/melian-agent/melian/issues/126). Its two rules are withdrawn with the route. Rule (a)'s exception for a file renamed with identical content no longer contradicts [evidence locations](2026-10-04-evidence-locations.md), which stands as written. A `cause` location anywhere in a file the change renamed without editing proves `affected`. Rule (d), which refused a re-scope on any deletion inside the function, has nothing left to refuse.

## What this gives up

The held decision's two give-ups become permanent:

- A finding whose own range overlaps a changed line keeps its `introduced` cause and may block, though its failing lines and their callers are untouched.
- An `affected` finding whose proof sits in a file the change renamed with identical content keeps its cause.

Each one costs a dismissal, and so a host round, until [issue #315](https://github.com/melian-agent/melian/issues/315) lands. Until then, each restatement of the same defect needs its own.

## Why not a route

- Reverse closure: the compiler lists, at base and head, every function that can reach the failing one. The re-scope is accepted only if all of them are unchanged, comments aside, and none is new. That is the soundest route, and it covers TypeScript alone. It would refuse whenever the change touches a file outside the compiler's program, which almost every Melian pull request does. It would also need `CompilerGraph` on the review path, a base and a head program, and a version bump of the verification record, for a case a dismissal already answers.
- A named path, checked: the verifier names the trigger and each hop, and the compiler confirms each. A guard removed on a path the verifier did not name goes unchecked. That is the class step 17's five reviews found, now one step removed.

## The attacking review

The rule as written is that nothing a model writes changes a finding's cause. Each probe below tried a way through it, against `main` at `27797250`.

- A report with a top-level `scope` or `cause` field. The probe ran `Value.Check` on `reportVerdictSchema`: refused, since the schema sets `additionalProperties: false`.
- The same field inside `answers`, `lower` or an evidence entry, or an object for `correction`: refused.
- A lowering to `nit`: the schema accepts it, and `Lowering.refusal` refuses it inside the `report_verdict` commit. A lowering is one step, P1 to P2 or P2 to P3, and it changes a severity, never a cause.
- The `code`, `guard` and `base` answers: stored, and no source outside the tool that stores them reads them.
- The correction: it is display text. The terminal rendering and the pull request publication print it under "Correction:", and nothing else reads it.
- The writer of cause: a lens finding's cause comes from `Revision.classifyCause`, called from `report_finding` in `packages/pipeline/src/lens-tools.ts`. It takes the finding's location, and the lens's evidence that Melian checks against the hunks. No verifier output reaches it. A guardrail or static finding sets its own cause from its check, and no model writes it.
- One way through remains, and it is cause by location's own. A lens is a model reading code the author wrote. It can leave out the `cause` location that would prove `affected`. The finding then reads `pre-existing` and is capped at `advisory`, though the change caused it. This decision changes nothing there. The limit predates step 17 and errs toward a finding that does not block. Cause by location records it: a location heuristic must never make an old defect block.

## What this leaves alone

Lowering, surfacing, conflicting reports and the stored record, as the held decision restates them, all stand. The eleven verifier goldens in `packages/evals/verifier/` stand.
