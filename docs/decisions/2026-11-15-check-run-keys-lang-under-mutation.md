# A check run keys `LANG` when mutation runs the head's tests

Amends: [Request keys as built](2026-11-14-request-keys-as-built.md), the exclusion of the four variables a tool runs with

Status: for [issue #454](https://github.com/melian-agent/melian/issues/454). The maintainer agreed on 2026-11-15, in the coordinator's session, to accept the gap on [pull request #436](https://github.com/melian-agent/melian/pull/436) and fix it here. The coordinator chose how on 2026-11-15, in a message to the builder: key `LANG`, and record the other three as exclusions. That is a choice of approach, not a ruling. The limit in the last section is a consequence the builder sees, and waits on the maintainer.

## Problem

The request-keys decision leaves out `PATH`, `HOME`, `TMPDIR` and `LANG`, the four variables every static tool runs with, because they name the host. It adds that Melian stores no tool's text, so `LANG` cannot change a finding. That holds for Biome and tsc, whose findings are fixed sentences. It does not hold for `static.mutation`, which runs the head's own tests under Stryker with those four variables. A test can read the locale. Example: a test that formats a date with `toLocaleDateString()` and compares it with a fixed string passes under `en_AU.UTF-8` and fails under `C.UTF-8`, so whether it kills a mutant depends on `LANG`. Two hosts with different locales then share one key and one answer.

## Choice

With mutation on, the check run's request holds `LANG` beside Stryker's facts, the head's trust and the cold flag: the value the tools run with, or null when the Melian process has none. With mutation off it holds no `LANG`, so a macOS host and a Linux builder with different locales still share Biome's, tsc's, Enola's and the guardrails' results. A locale such as `en_AU.UTF-8` names a language, not a machine, so keying it is within rule 6 of [the identity guideline](../guidelines/identity.md#rules).

The key reads `LANG` from the same list the static runner passes to every tool, so the value keyed is the value a tool sees.

## What stays out, and why

A test under mutation can turn on each of the other three, and each names the host, so none enters the key:

- `PATH` decides which `git`, `sh` and `node` a test spawns. Stryker's bin starts with `#!/usr/bin/env node`, so it can run under another Node than the one the host facts name.
- `HOME` holds `~/.gitconfig` and `~/.npmrc`, which git and npm read inside a test.
- `TMPDIR` decides how long a temporary path is and whether it resolves through a symlink, as `/var` does to `/private/var` on macOS.

No bounded fact stands for them: neither the version of everything on `PATH` nor every file under `HOME` can be keyed. Marking each mutation run not reusable would cost more than the gap. A run that is not reusable never attaches, so every review of the head would start Stryker again, for 30 minutes to two hours. That repeat run builds on the head's incremental partition, so it is provisional and leaves the review not reviewed until someone runs `--cold`.

Today check runs live in the clone's own store, under the git common directory, so a mutation run is only reused on the host that ran it. Making `HOME` and `TMPDIR` stable by running Stryker with scratch directories, as `mutants verify` was to do by [the shards decision](2026-11-13-mutants-verify-runs-stryker-in-shards.md), changes what the mutation check does. It is left to an issue of its own.

## The limit this leaves

A mutation run is safe to reuse only on the host that ran it. A store shared across hosts, such as the export and import of [issue #425](https://github.com/melian-agent/melian/issues/425), would carry one host's mutation results to another whose `PATH`, `HOME` or `TMPDIR` differ, under the same key. Whether the shared record may carry a mutation run at all is a rule about what it reuses, and the maintainer's to make.
