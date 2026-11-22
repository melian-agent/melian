# Issue 561: a parity lock's refusal quotes nothing but a run's own claim

Builder agent: the Actions round on [pull request #625](https://github.com/melian-agent/melian/pull/625) at 3b69ac06 found that the refusal a run gives when its results file is locked quoted the lock file's first word. The lock path is `<results>.lock`, beside a results path the person chooses. Say that path is a link to a private file holding `PRIVATE_TOKEN_7f30a data`. The refusal followed the link and printed `says run PRIVATE_TOKEN_7f30a holds ...`.

The refusal now opens the lock without following a link, reads it only if it is a regular file, and prints a process ID only when the whole file reads as a claim this build writes: a process ID, a space, a UUID and a newline. Anything else gets a refusal that names the path and quotes nothing from it. `O_NOFOLLOW` with `fstat` on the open descriptor stands in for `lstat`, so the file cannot be swapped between the check and the read. The evals guideline says so.

On 3b69ac06, the new test "refuses a lock path that is a link, a directory or a file of other text, and says nothing the path holds" failed: the error printed `run PRIVATE_TOKEN_7f30a`. It now passes for a link, a directory, a file of other text, and a claim with text before or after it. The round also found that no test told two claims of the same process apart. The new test "stops without saving or releasing when a claim of its own process but another run took its lock" does. It passed on 3b69ac06, since the code already compared the whole claim; it now guards that comparison.

Mutants: the enumerator listed 30 over the fix commit, with none omitted. Twenty-seven were killed, each by hand against its named test alone. Three are equivalent:

- An empty encoding makes `readFileSync` return a buffer, which `exec` reads as the same string.
- Dropping the `finally`, or the `closeSync` in it, leaves the descriptor open. The refusal throws at once and the run exits, so nothing differs.

The inventory is `2026-11-21-issue-561-lock-refusal-mutants.json`.
