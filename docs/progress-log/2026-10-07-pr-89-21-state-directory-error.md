# fix(pipeline): keep git's reason in a state-directory failure

For [pull request #89](https://github.com/melian-agent/melian/pull/89), round 21. Node's callback-form `execFile` does not put stderr on its error, so `stateDirectory` printed `Command failed: git -C ... rev-parse` before git's reason. `CacheLocation.open` now attaches stderr. The repository test pins the message to `git rev-parse failed: fatal: ...`; it failed before the change and fails again without the attachment.
