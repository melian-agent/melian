# Enola's policy paths come from Enola, in one list

Amends: [Enola static policy](2026-10-06-enola-static-policy.md), the files the runner replaces with the base's copies

Status: a builder's fix for [issue #529](https://github.com/melian-agent/melian/issues/529). The issue's "Done when" asks for it. No ruling changed.

Choice: Core's `enolaPolicyFiles` and `enolaPolicyDirectories` name every path Enola 0.4.40 reads policy from: `enola.yaml`, `mcp-arch.yaml`, `enola-intent.yaml` and `.enola/suppressions.yaml`, and every file under `enola/constraints/` and `enola/recipes/`. `enolaPolicyPattern` is built from them. So are the paths the runner removes from each worktree before it copies in the base's files. A new path joins both by joining the list.

Why: the runner kept its own list of paths to remove, and both lists left out `enola/recipes/`. Enola reads `enola/recipes/<name>.yaml` in place of the recipe it ships under that name. A base that binds the shipped `layered` recipe in `enola/constraints/` checks `lay/infrastructure-does-not-drive-the-domain`. A head that added `enola/recipes/layered.yaml` without that rule switched the check off, with no policy notice. Run against the pinned binary on a scratch repository, the rule's finding vanished.

The list was established by asking Enola, not by reading its documentation. `strace` of `--generate` and `check` shows Enola opens every tracked file, so an open alone does not mark policy. Its own messages, and each file's effect on a run, do:

- `enola constraints lint` names `enola-intent.yaml` and `enola/constraints/` as where rules are declared, and lists each shipped recipe as `enola:recipes/<name>.yaml`. A repository file under `enola/recipes/` replaced one, as above.
- A Markdown page can carry an `enola_intent` block, but Enola refuses one that declares rules or components: "a page's decision references rule ids, never the rules themselves". A page's claims are the head's own content, as its code is, so Markdown stays out of the list.
- An exemption attaches to a `use_recipe` entry under `enola/constraints/`, already in the list.
- Melian writes the configuration Enola reads, from the base's `enola.yaml` or `mcp-arch.yaml`, so a head's copy of either never reaches it.

Raise the list with the pin. A later Enola that reads policy from a new place needs it added, and the test that reads every listed path from the base updated with it.

The runner removes `.enola` before the listed paths, so a head whose `.enola` is a link loses the link before `rm` follows `.enola/suppressions.yaml` through it.
