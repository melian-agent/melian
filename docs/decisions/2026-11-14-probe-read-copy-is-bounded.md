# What a probe copies in from probe.read is bounded

Amends: [Probes run under sandbox-runtime](2026-11-07-probes-run-under-sandbox-runtime.md), ruling 1, the copy of each allowlist entry

Status: chosen by the builder for [issue #398](https://github.com/melian-agent/melian/issues/398), with the numbers approved by the coordinator on 2026-11-14. Not a maintainer ruling.

## Problem

Every `probe.read` entry other than `node_modules` is copied into the probe's scratch tree when the probe opens, and nothing bounded the copy. An entry such as `generated` that grew to hold a build's output, or a dataset, would be copied whole for every probe, filling the disk and holding the probe open for as long as the copy took. Each round runs probes again, so the cost repeats.

## Choice

The copies of one probe, together, may hold 50,000 entries and 512 MiB of file content, and must finish within 60 seconds of starting. `copyReads` counts each entry before `cp` writes it, through `cp`'s own filter, so no second walk can disagree with what is copied. Past any of the three bounds the probe is refused with `invalidProbe`, naming the entry and the bound, and `Probe.open` removes the scratch with the partial copy in it. Nothing runs unconfined and nothing is reused, so the bounds enter no key.

The numbers are about twice Melian's own install, 25,566 entries and 300 MB, which a four-core cloud container copied in 7.6 seconds, and half the head tree's limits that [pull request #296](https://github.com/melian-agent/melian/pull/296) sets for the probing level, since the copy repeats per probe. 512 MiB at that rate takes about 13 seconds, so 60 seconds leaves four times the margin and stays under the sandbox's 120-second setup bound.

## What it does not bound

A file is counted at the size it had when `cp` reached it. One that grows while it is copied is bounded by neither the byte limit nor the deadline, since the deadline is checked only between entries. The head's code does not run before the copy, so only another process on the reviewer's machine could grow a file then.
