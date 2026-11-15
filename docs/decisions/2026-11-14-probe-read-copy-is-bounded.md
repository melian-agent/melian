# What a probe copies in from probe.read is bounded

Amends: [Probes run under sandbox-runtime](2026-11-07-probes-run-under-sandbox-runtime.md), ruling 1, the copy of each allowlist entry

Status: chosen by the builder for [issue #398](https://github.com/melian-agent/melian/issues/398), with the numbers approved by the coordinator on 2026-11-14. Not a maintainer ruling.

## Problem

Every `probe.read` entry other than `node_modules` is copied into the probe's scratch tree when the probe opens, and nothing bounded the copy. An entry such as `generated` that grew to hold a build's output, or a dataset, would be copied whole for every probe, filling the disk and holding the probe open for as long as the copy took. Each round runs probes again, so the cost repeats.

## Choice

The copies of one probe, together, may hold 50,000 entries and 512 MiB of file content, and must finish within 60 seconds of starting. `copyReads` counts each entry before `cp` writes it, through `cp`'s own filter, so no second walk can disagree with what is copied. Past any of the three bounds the probe is refused with `invalidProbe`, naming the entry and the bound, and `Probe.open` removes the scratch with the partial copy in it, except as the last section says. The bounds enter no key, and none needs them. A refusal stores nothing a later run could reuse. A finished probing run is never reused either, by [the no-reuse decision](2026-11-14-probing-runs-not-reused.md), so no fingerprint holds a probe's limits; a change to the bounds takes effect on the next probe.

The numbers are about twice Melian's own install, 25,566 entries and 300 MB, which a four-core cloud container copied in 7.6 seconds, and half the head tree's limits that [pull request #296](https://github.com/melian-agent/melian/pull/296) sets for the probing level, since the copy repeats per probe. 512 MiB at that rate takes about 13 seconds, so 60 seconds leaves four times the margin and stays under the sandbox's 120-second setup bound.

## What it does not bound

The deadline is read on a monotonic clock before and after each entry, so a copy runs at most one entry past it, and a copy that ran past it is refused even when it finished. Nothing interrupts a copy that stalls inside one file, such as a slow 512 MiB file or storage that hangs: the probe is refused only once that copy returns. A file is also counted at the size it had when `cp` reached it, so one that grows while it is copied passes the byte limit. The head's code does not run before the copy, so only the reviewer's own storage or another process on the reviewer's machine can cause either.

## What a refused copy leaves behind

A read-only directory inside a `probe.read` path survives a refused copy, as it survives `Probe.close` on `main`. `cp` keeps the directory's mode, and a user other than root cannot delete files inside a read-only directory, so the scratch stays in the temporary directory with up to the bound's 512 MiB in it. `Probe.open` ignores that removal failure, and `Probe.close` reports it. Each probe opens a scratch of its own with `mkdtemp`, so a leftover does not make a later probe fail; a temporary directory that fills does. Cleanup makes only the scratch's fixed directories writable, because changing a mode by name inside a tree that holds the head's links could change a host file's. [Issue #447](https://github.com/melian-agent/melian/issues/447) removes the leftover without following a link.
