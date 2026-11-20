# Issue 561: a parity run whose lock another took saves nothing

Builder agent: Codex's adversarial review of [pull request #625](https://github.com/melian-agent/melian/pull/625) at 5454b11c found that a run whose lock was removed while it ran went on saving, and on exit removed whatever lock stood at the path. Say a person removes run A's lock while A is inside a review, and run B starts and takes the lock. A then saved over B's results and, on exit, deleted B's lock, so a third run could join B. The test "finishes a run whose lock was removed while it ran" asserted that A carried on.

The lock now holds the run's process ID and a random claim of its own. Before each save, the run checks that the lock still holds that claim. On exit it removes the lock only if the claim is still there. A run that finds its lock gone, or holding another run's claim, exits 2 without saving and leaves the lock as it found it. The evals guideline says so, and tells the person who meets a dead run's refusal to delete `<results>.lock` by hand.

The check reads the lock and then saves, so a run that takes the lock between those two steps still races. Only a person removing a live run's lock opens that window, and the guideline says to remove a lock only once its run is gone.

On 5454b11c, the new test "stops without saving or releasing when another run took its lock while it ran" got status 1: run A finished and saved. It now gets status 2 and the exact error. B's lock is left unchanged, and the results file holds only the pending attempt A saved before its review. A second new test removes the lock without replacing it and also expects status 2, with no lock left.

Mutants: the enumerator listed 28 over the fix commit, with none omitted. Twenty-five were killed, each by hand against its named test alone. Three are equivalent:

- The catch's empty block returns undefined, which reads as false.
- `rmSync`'s options are dropped, twice. `close` removes the lock just after reading it, so `force` matters only for a removal racing between the two.

The inventory is `2026-11-21-issue-561-lock-claim-mutants.json`.
