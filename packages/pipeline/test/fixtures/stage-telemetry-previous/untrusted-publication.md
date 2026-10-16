# Version-2 untrusted publication

`untrusted-publication.json` was written by `publishReview` and `publishExtension` from main at `ddf7c1136660eddac41bcad03dc0af64ede15c2d`, with Pi 1.1.0. The capture used the fake GitHub provider, `reviewScenario` and `lensScript()`. It supplied `trustedWriters: false` and read the running task from storage at the first `setStatus` call, before any provider write. No task field was built by hand.

The reopen test writes the recorded input and checkpoint through a version-2 token into SQLite. It changes only the current publisher document, then opens the version-3 extension. Each known attribution field and the trust setting must supersede the old task before any provider call.
