# Issue 543: Enola policy files with a newline in their name

[Issue #543](https://github.com/melian-agent/melian/issues/543). Melian reads Enola's policy from the base, removes the policy directories in both worktrees, and restores the files a pattern found. The pattern's `.` stopped at a newline, which git allows in a file name. A base that tracked `enola/constraints/core<newline>layer.yaml` lost that file in both runs, and a head that broke its rule ran clean, with no notice.

Enola 0.4.40 loads both kinds of file. In a scratch repository, a constraint file `enola/constraints/lay<newline>x.yaml` loaded and its rule fired. A recipe file `enola/recipes/lay<newline>ered.yaml` holding `recipe: layered` replaced the shipped recipe, since Enola names a recipe by its `recipe:` field, not its file name.

`enolaPolicyPattern` in `packages/core/src/enola-paths.ts` now carries the `s` flag, so a directory covers every file under it. The same pattern decides `isAnalyserConfig` and `analyserOf`, so such a file now counts as a policy change at head. `static.enola`'s check version rises to 4, because a run an earlier build stored judged the head without the base's file and would otherwise be reused.

Tests, each failing first on the old pattern for the reported reason:

- `packages/core/test/enola.test.ts`: both names are policy paths; the base's loaded policy includes both, and a head change to either differs.
- `packages/core/test/analyser.test.ts`: both names, in mixed case, are Enola's configuration.
- `packages/pipeline/test/enola-static.test.ts`: both Enola runs see the base's text of both files, not the head's.
- `packages/pipeline/test/check-request.test.ts`: the request keys Enola at version 4.

Mutants: `melian mutants list 3a35d3fb...HEAD` lists one, `"s"` replaced by `""`, which Stryker's configuration excludes. Run by hand at 692dd776 against `Enola policy and reports > recognises every policy path and leaves a committed baseline out` alone: it passed unmutated and failed mutated. The version number is no Stryker mutant; its test failed at 3 before the bump. The inventory is [2026-11-17-issue-543-enola-newline-policy-mutants.json](2026-11-17-issue-543-enola-newline-policy-mutants.json).
