# Prefer all carriers in the nearest directory

[Pull request #85](https://github.com/melian-agent/melian/pull/85), second fix pass, item 12.

Nearest preference compared carrier file names, so a sibling CLAUDE.md lost before root rules. It now compares directory scopes, including .melian/standards carriers and each carrier's imports. Both source kinds retain the nearest CLAUDE.md, its import and nested standards while omitting the root carrier under the cap. The rendered-cap decision already requires this directory preference.

The multi-directory cap tests now have sixty-second timeouts. The revision cap test exceeded five seconds even when rerun alone under machine load. Their assertions and bounds are unchanged.
