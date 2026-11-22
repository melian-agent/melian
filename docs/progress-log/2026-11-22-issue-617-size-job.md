# Issue 617, pull request B: read melian/state's size apart from every login

Builder agent: the coordinator asked that the step reading `melian/state` live in a job that holds no token if it can. It can, so it does.

On the first head of [pull request #645](https://github.com/melian-agent/melian/pull/645), the report job read the size. That step held no token itself, but its job declares the `melian-round` Environment, and later steps in it run scripts with `MELIAN_STATUS_TOKEN`. A step shares its runner's disk with the steps after it. Any code that step ran could leave files for those steps to run with the token.

The new `size` job runs after the gate. It declares no Environment and reads no secret. Its token can only read contents, and its checkout keeps no credential. It runs `melian records size --json` with the default branch's build. The store bounds what it reads from the branch: a listing of at most 64 MiB, and no blob. The step passes on its output only when it is at most 200 characters, all from `{}":,`, letters and digits. So no newline can add a job output and no `$` or space reaches a shell. The report job writes that output to a file, and `TipSize.parse` reads it as whole numbers. A failed or refused read leaves the output empty, and the comment says the size could not be read.

Mutants: the guard is shell inside the workflow, which the enumerator does not list. These mutants each ran by hand against the new guard test alone, and each was killed:

- the bound raised to 201;
- the character check dropped;
- the class widened to any character, a space, `@`, `$`, and escaped parentheses with `$`;
- empty output allowed;
- `exit 1` removed;
- the output line removed;
- the condition inverted;
- `&&` swapped for `||`.

The structural test killed two more: the job taking the Environment, and the read step taking a token. One mutant, `$()` inside the class, is equivalent: bash reads an unquoted `$()` inside `[[ =~ ]]` as an empty command substitution, which leaves the class as it was.

Two existing assertions list jobs, and each gained `size`. Their outcomes are otherwise unchanged.
