# Prove publication attribution migrations

[Pull request #86](https://github.com/melian-agent/melian/pull/86)’s inventory now preserves known version-6 attribution through migration. Direct SQLite reads check absent, true and false legacy publisher trust before a publication can overwrite it.

A publication call refreshes PublisherDocument before resuming tasks. That hides its migration’s defaults in end-to-end tests. Test that migration through a reopen and snapshot before invoking publication.

Removing an attribution default, discarding known attribution or skipping either document migration fails its corresponding snapshot assertion.
