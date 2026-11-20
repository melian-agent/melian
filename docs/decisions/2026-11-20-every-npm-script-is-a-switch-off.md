# Every npm script the base had counts as a switch-off

Status: a builder's choice, made on 2026-11-20 for [issue #589](https://github.com/melian-agent/melian/issues/589), which asked for the choice to be recorded here. It is not a maintainer's ruling.

## Problem

CI runs `npm run check` from the head's own `package.json`. So a head that rewrites that script makes the gate do less, or nothing, and CI still reads green. Melian's notice on a changed `package.json` said only which analyser the file configures. It named a switch-off only when the head deleted the file.

Example: a head changes `"check": "biome check … && vitest --run"` to `"check": "true"`. Every CI job passes, and the notice gave no sign that the gate's own command changed.

## Rule

`switchOffs` in `packages/core/src/analyser.ts` names each script the base's `package.json` had that the head changes or removes. It does this at any depth and in any letter case of the name. A script whose value differs as JSON is changed. A script missing from the head's `scripts`, or every script when the head's `scripts` is absent or not an object, is removed. A script the head only adds, and a change to any other field, add nothing. When the head's file does not parse as a JSON object, nothing is added, since npm then cannot run any script and the gate fails on its own.

Every script counts, not only those a workflow or another script runs. The issue asked that this be read from the authority, the workflows and the scripts, rather than a hand-kept list of names. No such reading is complete:
- `npm run check` also runs `precheck` and `postcheck`;
- npm runs lifecycle scripts such as `prepare` and `postinstall` that no caller names;
- scripts call each other from shell strings, which only a shell parser could read.

Following the authority would mean re-deriving npm's and the shell's rules by hand. So the rule counts every script the base had.

The notice quotes only script names, as JSON strings, and takes them from the base. No text from the head reaches the stored finding: a head's script value, or a name the head adds, never appears in it. JSON quoting keeps a newline or quote in a base name from reading as prose.

This changes the notice's words, not what blocks. The notice on a changed `package.json` already blocks at `analyserSeverity`.

## Limit

A head that adds `precheck` changes what `npm run check` does, and the notice does not name it, as the issue asked. A person still reads that diff, because the notice blocks. Reporting added `pre` and `post` scripts would be a follow-up.
