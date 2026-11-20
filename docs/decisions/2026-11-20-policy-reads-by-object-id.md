# A lint rule keeps policy reads on the revision source

Status: for [issue #539](https://github.com/melian-agent/melian/issues/539), part two. The maintainer ruled on 2026-11-18 to build it, as the coordinator relayed on 2026-11-20. The coordinator chose the grandfather list and the follow-up on 2026-11-20.

## Problem

Core's `AGENTS.md` says policy, standards and lenses are read only through `src/source.ts`. That source resolves the commit, lists its tree, and reads each file by its object ID. A read of `<revision>:<path>` with `git show` or `git cat-file` skips that check: git resolves the name itself, and a mislabelled object behind the path returns other content. Nothing stopped a new caller writing one.

Example: the CLI once read a pull request's `melian.yaml` with `git show <base>:melian.yaml`. A reviewer would see nothing wrong with that line.

## Choice

A Biome Grit plugin, `biome/object-by-path.grit`, reports a string or template shaped `<revision>:<path>` inside a function body or arrow function that also contains `"show"` or `"cat-file"`. Its message points to `packages/core/src/source.ts`. It runs on every file under `packages/*/src/`.

It leaves alone a colon that is not an object name. A refspec that starts with `+` passes, and so does a URL, whose colon is followed by `/`. An option such as `--format=%H:%T`, a message with spaces and a peeled name such as `<sha>^{commit}` pass too. So does a label in a function that runs neither command.

One file offends today. `blobText` in `packages/core/src/guardrails.ts` reads `package.json`, `melian.yaml` and analyser configuration by path. It is the plugin's one exclusion in `biome.json`, until [issue #591](https://github.com/melian-agent/melian/issues/591) moves it onto the revision source. The exclusion covers the whole file, so a test lints it with the exclusion lifted and requires exactly the one read it was excused for. A second read added anywhere in it fails the test, and so does removing `blobText`'s, so the list only shrinks.

## Known limit

The rule matches within one function. An argument array built in one function and passed to git from another is not seen, and nor is a name built by concatenation with `+`. It also misses a name built in an inner arrow and fed to `cat-file --batch`, a name in a module-level `await` or a class field's initialiser, one built with `String.raw`, a colon written as `\x3a`, and a `"show"` held in a constant outside the function. A reviewer still owns those cases.

A refspec without `+`, such as `refs/pull/1/head:refs/melian/pr`, is reported when its function also runs `show` or `cat-file`. Write it with `+`, or build it in a function of its own.

## Proof

`scripts/object-by-path.test.mjs` lints scratch files with the plugin wired as the root's `biome.json` wires it. It reports six shapes: a template naming a revision and a path, one held in a variable, a literal, an index path, `[c, p].join(":")` and an arrow function's body. It passes six others: those listed above. It checks that each grandfathered file is excluded while another source file is reported, and that each grandfathered file, with its exclusion lifted, reports exactly the reads the test records for it.
