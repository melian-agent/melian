# Count omitted files and symlinks separately

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, item 4.

Doctor counted every remaining carrier in “and N more”, but its total excluded symlinks. The remainder now names regular files and skipped symlinks separately. A CLI regression covers twelve regular files and a symlink beyond the ten-path list.
