# Guard standards path headings inside prompt boundaries

[Pull request #85](https://github.com/melian-agent/melian/pull/85), eleventh round, finding da3b5341ca0939ee. Quoting only standards content left a hostile path heading in trusted prompt text. All 97 existing lens and standards-review tests passed that mutation.

Two fake-model regressions capture prompts from a worktree carrier and a flat section. Their path contains a newline and an instruction to approve everything and report nothing. Each test requires the complete heading and content inside a standards boundary. Removing every standards block leaves no path, heading or hostile instruction outside.

Both tests pass the unchanged implementation and fail when only the content is quoted. The mutation is restored after each probe. No production behaviour or design decision changes.
