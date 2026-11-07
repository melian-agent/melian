# Melian stores no Biome or tsc text

Status: ruled by the maintainer on [pull request #282](https://github.com/melian-agent/melian/pull/282), 2026-11-07, for [issue #281](https://github.com/melian-agent/melian/issues/281): "store no tool text". Reading is not the leak; echoing is. The file keeps the name of the rule it replaced before merging, a check of each tool's configuration, so the links to it hold.

Amends: [Static checks run unconfined; only agents are sandboxed](2026-10-14-static-checks-run-unconfined.md), the second bullet of "What this gives up", which accepted that a head's `biome.json` extending an absolute path has Biome quote that file.

## Problem

Biome and tsc read whatever files a head's configuration and sources lead them to, outside the checkout too, and quote them. Melian stored what they printed. A stored message reaches the verdict, `melian findings`, published reviews, and the lenses and verifier that read static findings.

Example: the Opus review of record on [pull request #275](https://github.com/melian-agent/melian/pull/275) committed `{"extends": ["<absolute path>/environ"]}`. Biome could not parse the file and quoted it, a fake token included, under the label `biome.json:1:1`. Melian kept 4,096 characters of that stderr as the check's error. [Pull request #112](https://github.com/melian-agent/melian/pull/112) met the same class in its fallback.

The first form of [pull request #282](https://github.com/melian-agent/melian/pull/282) followed each tool's `extends`, `plugins` and `references` before it ran, and refused a path outside the checkout. Its first round and Codex's review found four routes past it at once: a bare project reference, a quoted path that resolves differently, a symlink, and a source import whose types tsc quotes. A short attacking review of reading configuration from the base found four more: a committed symlink under the base's `include`, workspace `package.json` metadata, a `/// <reference path>` directive, and a symlinked configuration directory. Each tool resolves files its own way, and TypeScript 7 has no in-process API to ask. Hand-resolving what the tools read would not converge, so the check was removed.

## Decision

1. A Biome or tsc finding keeps its rule code, file, line, column and severity, never the tool's message. Its message, its explanation and its identity's discriminator are a fixed sentence naming the tool and the rule, such as "tsc reports tsc/TS2322 here. Melian keeps none of tsc's text; run tsc --noEmit at this commit to read its message." `staticFindings` in core applies it, so every stored document, the verdict JSON, `melian findings`, a published review, and the text a lens or the verifier receives carry only that sentence. Lenses and the verifier read the source line themselves.
2. A failed Biome or tsc run keeps its exit code and a fixed sentence naming the command that shows why. Neither tool's stdout nor stderr is stored.
3. The head's tool configuration is read as it is on `main`, so the base-versus-head comparison is unchanged.

This closes every route named above, and any not yet found, because no route reaches stored text.

## What this gives up

- A static finding no longer says what is wrong. A reader runs the tool at the commit, or reads the source line, as the lenses and the verifier do.
- A result with no code to identify it by, in a file too large to read, a symlink or a blank line, was identified by its message. It is now identified by its line and column. A result the base lacks at that place is introduced, so an edit above it in such a file makes a result read as introduced again. Matching by count alone merged every result of one rule in the file, so a fixed error and a new one cancelled out and the new one read as pre-existing. A hash of the message would not help: a message that holds a short secret can be recovered from its hash by trying every value.
- Counts and places still carry a little. A writer can commit TypeScript conditional types that inspect an outside declaration, reached through a committed symlink, a `/// <reference>` or an import, so that tsc reports one diagnostic or two depending on its content. Melian keeps those counts and places, so each review round can leak one bit. The maintainer accepted this: it needs a writer to commit type-level probing code that the diff shows, and one round per bit. The general fix is a read sandbox for the static tools, to come as its own issue when customers need writer heads confined.

## Other static tools

- Enola reads its policy from the host's trusted commit, never the head's, so a head's configuration cannot steer what it reads. Its results quote symbols from the head's sources, and a failed run keeps Enola's message. Whether Enola follows a committed symlink out of the tree has not been probed. That is a follow-up.
- The mutation check runs the head's own tests, and only with the host's leave: a writer pushed the head, or the reviewer passed `--trust-head`. It stores the end of Stryker's output and each mutant's replacement text, and a test can print any file it can read. A head allowed to run code can already read any file the reviewer can, so withholding that text belongs with milestone 3's credential-free job. That is a follow-up too.
