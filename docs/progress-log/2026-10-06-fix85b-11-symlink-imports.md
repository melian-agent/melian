# Skip imports below symlinked directories

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, item 11.

The worktree ignore check threw when an import passed through a symlinked directory. The loader now treats git’s specific symlink refusal as an excluded import, preserving ignore notes for absent revision blobs. Both sources skip the hidden path without invoking readText.
