[Pull request #131](https://github.com/melian-agent/melian/pull/131) builds plan step 27, "Merge by shared cause", on top of [pull request #130](https://github.com/melian-agent/melian/pull/130). After the snippet pass, a second pass joins whole snippet groups of lens reports alone when the change caused them through one hunk, over overlapping lines. It takes groups by end line, then start line, then lowest ID. On the golden `design-supersedes-its-own-decision`, the three reports of the fail-open default in `src/publish.ts` are now one defect, and the caller in `src/cli.ts` stays apart.

Two attacking reviews set the design. The second ruled that the merge runs in two passes, that groups are ordered by line, that a refuted report never speaks while another stands, and that a member's ID dismisses that report alone. The refuted-speaker and member-dismissal changes apply to snippet merges too.

The adjudication task moves to version 2. It stores the outline of the files the findings name, and a version 1 input decides by snippet.

The commits:
- b465ca42 holds the failing tests.
- fda2e974 and 02e7737f hold the implementation.
- 4c6ae083 holds the documentation.
- aba73f63 reduces the rule and adds a test for each guard.

The hand mutation inventory killed 41 of 43 guards. One survivor is the start-line key, equivalent in a brute-force search. The other is the publish plan's held set, which the decision states as a limit.
