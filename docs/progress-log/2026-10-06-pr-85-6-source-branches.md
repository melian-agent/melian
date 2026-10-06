# Guard nested revision ignore rules and source failures

[Pull request #85](https://github.com/melian-agent/melian/pull/85), fourth fix pass, finding ac769bd0d7df1ec7. The import-safety fixtures now force-add docs/private.md behind docs/.gitignore. Both sources refuse the import, name it in the note and never call readText on that path. A second fixture proves a nested negation overrides a root exclusion.

Restricting RevisionSource.isIgnored to the root .gitignore fails both revision fixtures. Both worktree fixtures still pass. The loop was restored.

A source-reader branch audit found missing assertions for ignore-file errors, failed git commands, corrupt refs, special files, directory reads and file replacement races. New tests cover those paths using real temporary repositories. Fault injection covers a read failure after opening a file and confirms the handle closes. No provider is called.

The V8 inspector needs Debugger.enable before Debugger.getScriptSource. Node's ESM namespace exports cannot be spied on directly; Vitest's spy module mock forwards filesystem calls and permits fault injection. Coverage scratch files stay under tmp.
