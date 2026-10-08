# Round six fixes for [pull request #102](https://github.com/melian-agent/melian/pull/102)

`fix(design): refuse missing sections in CommonMark links` resolves reference links and optional titles before bounded section reads. Loader tests cover present and absent sections; a fake-model review refuses missing sections before asking the design model. Mutations prove the traversal, destination selection, filters and refusal. The remaining fixes and full-gate result follow in this entry.
