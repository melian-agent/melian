# Issue 529: fixes from the review of record

The review of record on [pull request #534](https://github.com/melian-agent/melian/pull/534) found four things, and this pass deals with each.

- `analyserConfigNames` in core spelled Enola's paths out by hand and left out `enola/recipes/**`. It now takes them from `enolaPolicyFiles` and `enolaPolicyDirectories`, in 652ce934. Its test in `packages/core/test/analyser.test.ts` failed first for that reason and passed after. The two mutants on the changed line, an emptied arrow and an emptied template, were run by hand against that test alone. The test passed unmutated, and both mutants were killed.
- The mutant inventory gave its evidence as text, which the sampler refuses in a version-2 inventory. Each claim now names its test by file and title path, in f32ec784, and `node scripts/enumerate-mutants.mjs --sample` accepts it.
- The decision claimed its list was every path Enola reads policy from. The packwerk check reads `packwerk.yml` and `package.yml` from the head, so the claim now says the list is what Melian replaces from the base. Whether those files raise a policy notice is with the maintainer, by the coordinator's answer on [issue #529](https://github.com/melian-agent/melian/issues/529#issuecomment-6932910260). No code changed for it.
- The scope the maintainer added to #529, that a shared Enola finding with no location carries no hash of the tool's message, moved to [issue #535](https://github.com/melian-agent/melian/issues/535), by the coordinator's answer. It waits on the maintainer's choice of approach.
