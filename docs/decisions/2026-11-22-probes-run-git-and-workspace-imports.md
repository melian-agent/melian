# Probes run git and import workspace packages

Amends: [Probes run under sandbox-runtime](2026-11-07-probes-run-under-sandbox-runtime.md), the reads and the environment a probe starts with

Status: chosen by the builder for [issue #644](https://github.com/melian-agent/melian/issues/644), with its scope set by the coordinator on 2026-11-22. The maintainer accepted the widened read on macOS on 2026-11-22, in the coordinator's session, after the coordinator's host run at `8aa451e7`; [the record on pull request #646](https://github.com/melian-agent/melian/pull/646#issuecomment-7074034184) states it. The list under "What a probe may read on macOS" is what he accepted, in the order the code grants it, so a later widening shows as a change to it. The rest of this file is the builder's choice, not a ruling.

## Problem

A probe that runs Melian's own code failed in two ways.

A bare import of a workspace package failed everywhere. `import("@melian-agent/core")` from a probe's script ends in `ERR_MODULE_NOT_FOUND`. The script lives in the probe's own folder, beside the tree rather than inside it, so Node never walks up to the tree's `node_modules`. With that fixed, Node still resolves the package's `default` export, `dist`, which nothing in a checkout builds. Melian's workspace resolves through the `@melian-agent/source` condition.

git failed on macOS. `/usr/bin/git` is the `xcrun` launcher, which needs the developer tools. With them on `PATH` and readable, git starts, then dies reading its system configuration, `/etc/gitconfig`, with `EPERM`. So a probe could not run `git init`, nor the `melian` CLI that runs git.

## Choice

The root policy's `probe.conditions`, read from the base, names Node conditions. The probe's runner starts the script with `NODE_OPTIONS` holding `--conditions=<name>` for each, so every node the probe starts resolves under them too; a flag would reach the probe's own process alone. A condition takes at most 100 characters, of letters, digits, `@`, `_`, `.`, `/`, `:`, `+` and `-`, and starts with none of the last five, so it never reads as a flag, and holds no space, so joining them keeps each whole. A probe that changes `NODE_OPTIONS`, or passes node any flag, gains nothing: it already chooses its children's environment and arguments, and every child runs inside the same sandbox. A policy takes at most 16. The probe's folder links `node_modules` to the tree's, and the name `node_modules` is reserved among a probe's files.

On macOS, before the sandbox starts, the host answers four questions. `xcode-select -p` names the developer directory, `xcrun --find git` names git, and that git answers `--exec-path` and `var GIT_CONFIG_SYSTEM`. Each runs with `PATH=/usr/bin:/bin`, `HOME=/var/empty` and no other variable, so the reviewer's `GIT_CONFIG_SYSTEM` cannot steer the answer. The probe may then read four places: git's program, the real file `xcrun` names, links followed; its exec path; `<prefix>/share/git-core`; and the system configuration, at its own path and at the path a link there leads to. The probe's scratch holds a directory of its own with one entry, a link named `git` to that program, and that directory goes on `PATH` after Node's. The program must be an executable file inside the developer directory, or git is unavailable. Its neighbours in the developer tools' `usr/bin`, such as clang, make and python3, are neither granted nor on the probe's `PATH`. sandbox-runtime writes a file's grant as a `subpath`, which matches that file and nothing beside it, so one file can be granted alone. The coordinator chose this on 2026-11-22, after the host showed that the exec path's own `git` is a link to `../../bin/git`. The same host run showed that a probe can already run `/Library/Developer/CommandLineTools/usr/bin/clang` by its absolute path, with no grant from this change and on `main` too. That is [issue #647](https://github.com/melian-agent/melian/issues/647), which the maintainer chose on 2026-11-22 to hold, and this change neither adds nor removes it.

### What a probe may read on macOS

The maintainer accepted these reads on 2026-11-22. A probe's sandbox grants them after the system's own reads, in this order:

1. The probe's own directory `<scratch>/git`, readable and not writable, holding one link named `git` to the program below. That directory is on the probe's `PATH` after Node's.
2. The one git program the host names, `xcrun --find git` with links followed, checked to be an executable file inside the developer directory.
3. git's exec path, `git --exec-path` with links followed.
4. `share/git-core` beside the program's `bin`.
5. The system configuration file that `git var GIT_CONFIG_SYSTEM` names, only where it exists, at its own path and at the path a link there leads to.

Nothing else in the developer tools' `usr/bin` is granted or on the probe's `PATH`. Linux gains nothing.

Where the system configuration the host names does not exist, the probe reads only the first three, and its environment sets `GIT_CONFIG_NOSYSTEM=1`. The coordinator's host run on 2026-11-22 showed why. The host names `/etc/gitconfig`, which does not exist there. sandbox-runtime keeps an absent path's spelling and grants it, as `/etc/gitconfig` and `/private/etc/gitconfig`, yet git's open of it inside the sandbox still failed with "Operation not permitted", which git treats as fatal, where "no such file" is not. The variable only takes configuration away, so it widens nothing. sandbox-runtime cannot grant `/private/etc` alone without what it holds: every literal read it writes is a `subpath`. The coordinator chose this approach on 2026-11-22; it is not a maintainer ruling.

Melian's own git calls keep `GIT_CONFIG_NOSYSTEM` when the caller's environment sets it, so the `melian` CLI run inside a probe skips the absent file too. `gitEnvironment` in core already kept it. The two places that dropped every `GIT_` variable, the tool cache's location and `melian store prune`, now go through core's `withoutGitVariables`, which keeps that one variable and drops every other `GIT_` variable. A caller cannot use it to add configuration.

The lookup refuses any answer that would widen the read past the developer tools and git's configuration:

- an answer that is not one absolute path;
- a developer directory that holds or sits inside the reviewer's home, which `/` always does;
- a git program, exec path or share directory that is not inside the developer directory, links followed, and an exec path or share directory that is the developer directory itself;
- a git program that is not an executable file, which the developer directory, being a directory, never is;
- a system configuration that is a directory, or that holds or sits inside the reviewer's home, at its path or through a link.

A git before 2.42 has no `git var GIT_CONFIG_SYSTEM`, and a refused or failed lookup leaves git unavailable: the probe reads nothing more, and `melian doctor` warns on its `probes` line. Linux asks nothing, since git lives among the system's programs a probe already reads.

## Keys

The conditions enter the probing environment, and so the lens request's key, only when the policy names one. A policy that names none keeps the key it had. Where the developer tools live is left out, as what the read paths hold is: it names the host's install, which a reinstall moves.

If git on some layout needs a library outside those directories, it fails in the probe, and `melian doctor` names git's error; the read is not widened for it.

## What remains unproven

The real-process tests run in CI's macOS job, which `scripts/macos-tests.json` lists. A Linux session tested the macOS lookup against a fake of the host's answers only. The coordinator's host run showed that a grant of an absent `/etc/gitconfig` does not suffice, which is why an absent configuration now sets `GIT_CONFIG_NOSYSTEM` instead. Whether a present configuration's grant suffices is unproven on a host that has one.
