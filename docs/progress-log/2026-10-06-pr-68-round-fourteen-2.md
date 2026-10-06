Fixed two comment findings from the fourteenth Melian round on [pull request #68](https://github.com/melian-agent/melian/pull/68). `ReviewThreadImporter.open` now documents CodeRabbit’s and Copilot’s bot names, reserving the human fallback for other authors. The existing recorded-GitHub test confirms both Copilot’s attribution and an unrecognised bot’s fallback.

Removed the comment above the private `endCursor` helper. It repeats the traversal and return value shown by the code, against `AGENTS.md`’s no-restatement rule. No behaviour or design decision changed.
