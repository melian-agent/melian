# A guardrails record fits the store, or its check fails

Status: the maintainer ruled, on [issue #605](https://github.com/melian-agent/melian/issues/605), that a guardrails record must fit the store's 4 MiB record limit, and that one which cannot fit even with every finding's detail left out fails closed. Trimming the check's own findings, rather than only the exported record, is the builder's choice, which the coordinator agreed on 2026-11-20; it is not a ruling.

Amends: [2026-11-13-shared-record-behind-a-store-port.md](2026-11-13-shared-record-behind-a-store-port.md), the record-size limit. Every store refuses a record past `recordLimit`, and a refused record never lists; a batch may still land in part, as the port allows.

Amends: [2026-11-20-every-npm-script-is-a-switch-off.md](2026-11-20-every-npm-script-is-a-switch-off.md), the notice that names each changed or removed script, in a trimmed record alone. Building the headline from kinds, not names, is the coordinator's choice of approach on 2026-11-20, not a ruling; the maintainer has been asked.

## Problem

Every record store refuses a record past core's `recordLimit`, 4 MiB. A head that changes many workspace manifests makes one guardrails finding per manifest, each naming the scripts it changes, and their record can pass the limit. The store then refused the round's records after the harness had stored a verdict of findings, so the review threw a store error with that verdict standing.

Example: 1,500 changed manifests, each naming twenty long scripts, wrote a guardrails record of about 5 MB.

## Choice

- Past the limit, the guardrails check leaves out the detail of its last findings in ID order, as `SightingBudget.checkRecord.fit` does. A trimmed finding keeps its ID, rule, severity, resolution, place and What to do, so what blocks is unchanged. Its Why here names how many files lost their detail and says that `git diff` shows them. A finding that trimming would not make smaller keeps its detail.
- A record that still passes the limit with every finding trimmed fails the guardrails check, with `RecordError` `recordTooLarge` and a fixed sentence that holds no finding's text. The review reads not reviewed, and its records export.
- Every check's record gets the same budget, not the guardrails alone. A static tool may write 16 MiB of output, so enough Biome, tsc or Enola findings could pass the limit after adjudication had stored a verdict; `runCheck` fits every check's findings where it forms the outcome. This extension is the builder's, from Codex's adversarial review; it is not a ruling.
- The trim applies to the check's own findings, not only to the exported record. The verdict's fingerprint hashes the findings' text, so trimming at export alone would give the local and the shared verdict different texts for one round.

## A trimmed notice names the kind of change, not the script

A trimmed finding's What becomes its headline. A notice's switch-offs name what changed, such as the scripts `"check"` and `"lint"`, but they sit in What, so a trim would drop them, and a trimmed notice on a manifest whose gate script changed would read like one whose version changed.

Example: a head changes 1,700 workspace manifests' scripts and the root's `check` script. The root's notice sorts past the cut, so before this change its trimmed form said only "Review the change to package.json, which configures the packages Biome and tsc load."

So a notice's headline names the kind of each switch-off in a fixed clause, with no name from either revision: "The head changes npm scripts and removes npm scripts." The kinds are: deletes the file; turns on `noCheck` or `skipLibCheck`; turns Biome's linter off; makes Biome ignore files this change touches; changes npm scripts; removes npm scripts; has npm scripts Melian cannot read. A notice with no switch-off keeps its headline unchanged.

In a trimmed record, then, the root's changed `check` script reads the same as any other manifest's changed script: the notice says scripts changed and does not say which. Its Why here says the detail was left out and that `git diff` shows those files. The headline is in no key: a notice's ID comes from its file, rule and discriminator, and its reopen from the blobs, so the clause changes no ID, dismissal or fingerprint match.

## What it costs

A reviewer on the host also sees the trimmed detail for a very large change, though the host's own store could hold it whole. `git diff` still shows each file. A change too large to record at all gets no review until it is split.

The shared check record carries that failure's reason as `unexpected`, since `recordCodes` lists only check errors' codes, so a reader on another host does not see that the change was too large; [issue #622](https://github.com/melian-agent/melian/issues/622) would share the reason.

## Known limits

The budget measures a check's findings as the check forms its outcome, not the records the review exports. [Issue #626](https://github.com/melian-agent/melian/issues/626) would measure those instead. Until it lands, three cases remain, chosen by the coordinator on 2026-11-20 on [issue #605](https://github.com/melian-agent/melian/issues/605). None lets a verdict pass that should block, since the verdict is decided from the local findings, which are complete:

- **The relay batch.** Each check's record fits the store alone, but the relay carries a round's records in one batch of at most 8 MiB. Three valid 3 MiB check records pass the store and the verdict, and the relay then refuses the batch. The reader sees a refused relay, and the round's records are lost.
- **A projection smaller than the local findings.** The shared record replaces a static tool's text with fixed sentences. A check whose own text is long can fail as too large when its projected record would fit. The reader sees a failed check, and the review reads not reviewed.
- **A projection larger than the local findings.** For Biome and tsc, the projected fixed sentences are longer than the local text: 518 bytes against 487 for one finding's message and explanation. A static check whose local findings come within about 6% of the limit can pass the budget while its exported record is past it. The store then refuses the record after the verdict is stored. The reader sees a store error with exit code 2, and no verdict in CI.
