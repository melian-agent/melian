# Keep every owed thread for one finding

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 4, fixes the finding-ID fold that lost older thread resolutions.
The regression left thread 1002 open after thread 1009 resolved, including on a settled rerun.
It now resolves both, while the older thread refuses resolution until the newer one succeeds.

Published-document version 8 rekeys recorded and pending resolutions by `replyKey` and keeps each finding ID in its entry.
A fixture written through version 7's publisher covers SQLite migration and a second reopen.
Pending review content, dismissal versions and reply journals survive.
Body-only resolutions keep the finding ID as their key.

The mutation inventory continues in `tmp/orphan-thread-pass4-report.md`, with exact replacements and failing logs.
The full gate and final head are recorded there after the remaining pass-4 fixes.
The implementation plan stays unchanged during this fix pass.
