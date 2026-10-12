# The lens roadmap after the review-tool research

Status: planned work. Nothing here is built.

Problem: two research notes show kinds of finding Melian's lenses do not ask about, and Melian had no recorded answer on which to build, in what order, and which to leave. [The note on Claude Code's review angles](../research/2026-10-12-claude-code-review-angles.md) names ten angles. Two of them, language pitfalls and wrapper fidelity, have no Melian rule. [The note on CodeRabbit's categories](../research/2026-10-12-coderabbit-categories.md) sorts 172 findings, and 63 fit no Melian lens: specification, documentation, copy, and accessibility. It also counts 13 findings in CodeRabbit's security and privacy category, 9 of them major.

Example: in that sample, any signed-in user could change a setting on another user's record, because the route checked only that no record existed. The note sorted that finding into `trust-boundary`, the nearest lens, with eleven others. But `trust-boundary` asks whether untrusted data reaches something that trusts it. Its question does not ask about authorisation, sessions, cryptography, or data exposure, and it has no rule for a missing permission check. The sample shows the size of the gap, not an ownerless bucket: the lens nearest these findings never asks for them.

## Milestone 2

The `design` lens gains `reimplements-an-authority` in step 19, after the verifier and resolution steps. [Ask the authority](2026-10-12-ask-the-authority.md) records the rule and its two goldens. The other lens rules below wait for milestone 3.

## Milestone 3

**A `security` lens beside `trust-boundary`.** It covers:

- authorisation: who may act on which record;
- authentication and sessions;
- cryptography misuse;
- server-side request forgery;
- unsafe deserialisation and mass assignment;
- data exposure: a response or a log that holds more than its reader may see.

The boundary, so one defect has one owner. `trust-boundary` owns how untrusted data flows: into a sink unescaped, past a judge, out of the path it belongs in, or into a check it makes pass. `security` owns the controls an application enforces for itself. Those are who is signed in, what they may do, and what is kept secret. They also cover what a request may make the server fetch or build. Three cases sit near the line, and each gets one owner:

- A URL from a request that makes the server fetch is `security`'s. `trust-boundary` hands it over where `security` runs.
- A credential that reaches a log, a message, or head code stays `trust-boundary`'s `secret-exposure`. Personal or tenant data that reaches a reader with no right to it is `security`'s.
- Request text that reaches a query, a shell, a model, or markup stays `trust-boundary`'s `injection-sink`. Request bytes that become objects, or request fields that set attributes nobody listed, are `security`'s.

Each hand-off goes through `handoffs`, per file. Where `security` does not run, `trust-boundary` keeps what it reports today.

Tools come first for secrets and dependencies. gitleaks and a dependency audit are deterministic, and a lens that guessed at either would add noise. The lens leaves both alone.

Its goldens come from seeded examples or from a customer repository. Melian's own comparison records hold too few of these defects to draw five from.

A route note: Codex's content filter refuses some security diffs. A refused lens leaves the review not reviewed, so the lens needs a route that does not refuse. The default route for `security` is a Claude model. How one lens gets a route of its own is the step's to settle, since routes are per tier today.

**Two rules on existing lenses.** `contracts` gains a wrapper and proxy fidelity rule: a type that wraps another must send each method to the wrapped instance, and must forward every method its callers use. `correctness` gains a language-pitfall rule, for the classic traps of the change's language. Both come from the two angles Claude Code adds at its top efforts.

**A cleanup lens.** Reuse, simplification, efficiency, and altitude, as four rules of one lens. It ships outside the default tier. Its declared default is advisory, and a folder raises it through [resolution per lens and per rule](2026-10-12-resolution-per-lens-and-per-rule.md). The CodeRabbit sample held no finding of this kind, so the lens must not cost an author attention by default.

**A specification-consistency lens.** Two documents that disagree, or a requirement that no task covers. It ships outside the default tier. It is built only after a second sample confirms the need, with goldens from a customer repository. One repository supplied all 38 such findings in the first sample.

## Milestone 4

Learning from dismissals moves to the front of the milestone. In the CodeRabbit sample, 44 of the bot's 155 replies stored the decision a human gave when dismissing or clarifying, and later findings cited them. That loop is what keeps a dismissed finding from returning.

A history source for lenses follows it: blame, and earlier review threads on the files a change touches. Claude Code's `code-review` plugin runs a reviewer on each.

## The comparison importer

A CodeRabbit thread that the bot resolved, citing a fixing commit, counts as an accepted finding. In the sample the bot resolved a thread after a code change fixed the issue, and named the commit. That is evidence the author accepted the finding. A resolved thread with no fixing commit proves less, and stays for the maintainer to adjudicate.

## Not planned

- Accessibility as a built-in lens. It was 4 of 172 findings. Judging it needs the rendered interface and a component library's rules, which differ by repository. A repository that wants it adds its own lens, or a tool.
- A looser finder with a verifier that defaults to plausible. Claude Code's high effort does this to gain recall. Melian's goal is to be quiet. A verifier that keeps what it could not check hands that work to the author, one reply per finding. Melian's verifier already keeps a `plausible` finding when the mechanism is real.

Why this order: `security` comes first because its findings were mostly major in the sample and no lens's question asks for them. The cleanup and specification lenses come after it and outside the default tier, because their evidence is thinner. Dismissal learning leads milestone 4 because every other lens gets quieter with it.

This adds to [the lens backlog boundaries](2026-10-04-lens-backlog-boundaries.md) and replaces none of them. The boundary between `trust-boundary` and `security` takes effect when the lens ships.
