# Required status: publication attribution

Branch `required-status` records publication identity and writer trust per revision and in ledger run details. Stored records upgrade to version 6; interrupted publish tasks upgrade to version 2. Old records and inputs default to trusted writers without a known poster.

Trust off posts the review and ledger with an error status and a reason. A repeat stays stable. Crash tests cover GitHub accepting a status before the record commit. Authors without write permission remain publishable by the maintainer. The required-status switch and Actions host remain pending.

The first fix pass confirms that a changed publisher could resume with the old attribution. Publisher document version 2 records full attribution. Crash coverage changes both login and permission after the first status and checks the review, ledger and stored attribution.

The public publish API now requires explicit writer trust and refuses omission before writing. CLI regressions cover false trust at the base with true trust at the head, error text and exit 0, and a trusted clean review with success status.

The fix pass changes the retirement decision to the ten most recent eligible merged pull requests after 2026-10-06T00:00:00Z. Missing records and pending adjudications block retirement within that window. At least one adjudicated valid in-scope distinct shadow finding is required. This tightens the maintainer’s criterion and needs their confirmation; the stats command remains deferred.

A stored version-1 publish fixture now seeds an unfinished task in SQLite. Reopening with the current publisher migrates its input to trusted writers and posts one review and one ledger. The fixture also reopens the legacy publisher document without inventing an identity.

The first status write may repeat after a crash before its record commit. This is accepted and the crash regression pins three statuses, compared with two normally. The recovery guarantee avoids duplicate reviews and ledger comments, not every external write.

Version-5 published-document coverage now checks trusted-writer defaults on the revision and latest ledger round after reopening SQLite. It checks that no identity is invented and that statuses, replies and earlier one-line history survive. The migrated shape is written and reopened again. Existing version-5 reply migration coverage remains.

Doctor now warns that the base may be stale when only local main is available. A regression proves origin/main wins over a different local policy. A second probe reproduced the old ok state for the local-main fallback and now requires a warning with exit 0. Test setup must delete a symbolic ref with git symbolic-ref --delete; git update-ref -d deletes its referent.

Doctor’s hanging-viewer probe timed out on the original code. The full identity-and-permission read now has a ten-second deadline and an abort signal. Hanging viewer and permission transports produce a warning and exit 0. The deadline covers response parsing as well as receiving headers.

The fix-pass diff review moves publisher migration into PublisherState.upgrade, following the stored-shape rule. The legacy fixture now checks that its own migrated task completes publication with the one posted review’s ID. A fresh task cannot hide a failed legacy resume behind the final state.
