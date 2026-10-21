# A changed dismissal reason replaces an unanswered one

The fourth Melian round on [pull request #155](https://github.com/melian-agent/melian/pull/155) blocked on `730b0331b51f7636`.
Resolutions are keyed by thread and dismissal version. Suppose a crash left reason A queued but unanswered, and the maintainer then changed the reason to B. `redismissed` added B beside A, and the closing loop posted both. Main keyed resolutions by finding, so B replaced A.

The commit that queues B now drops every entry on the same thread that no reply carried, in the journal or on GitHub. An answered A stays as history.
The regression test failed on `12105a8b` with two replies, A then B, and passes after the fix. Tests also prove that a journalled A and an A shown on GitHub stay, and that an unanswered reason on another thread stays.
Hand mutations of each condition fail a test. The finding-ID check was dropped: each root carries one finding's marker, so the thread alone names the finding.
