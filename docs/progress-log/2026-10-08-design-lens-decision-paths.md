# Base discovery includes decision filenames with a newline

The branch review found that the decision-path regex used a dot without the s flag. Git permits a newline in a filename, so discovery could omit a base decision. The pattern now matches those paths. Rendering escapes the newline and keeps the entry on one row. A real repository test fails when the flag is removed.

The immutable snapshot factory is named load. The repository reserves open for an object that is later closed; this snapshot holds no resource to close. The decisions guideline records the path-matching trap.
