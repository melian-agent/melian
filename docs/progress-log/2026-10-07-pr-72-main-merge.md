# Merge of main into the adjudication branch

[Pull request #72](https://github.com/melian-agent/melian/pull/72) took `main` after [pull request #68](https://github.com/melian-agent/melian/pull/68) landed. The importers, matching, bounded shapes and thread importer keep their final form from [pull request #68](https://github.com/melian-agent/melian/pull/68).

`ComparisonError` and its codes are in `errors.ts` again. The adjudication module throws it, and `comparison.ts` imports the adjudication schema. Defined in `comparison.ts`, the error made the adjudication module fail to load first.

The two new codes, `unknownFinding` and `invalidAdjudication`, sit beside the old ones. Five tests from that pull request now expect the `reviewers` an import stores.

A mutation pass covered every guard this branch adds, 298 in all. No test failed under 126 of them, and each now has an assertion, except five equivalent mutants. One branch of the export that no input could reach is gone.
