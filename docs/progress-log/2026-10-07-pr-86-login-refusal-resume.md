# Guard a known publisher login that becomes unknown

[Pull request #86](https://github.com/melian-agent/melian/pull/86) addresses Melian finding 70be974565411290. A task interrupted with a known publisher login, then resumed with `/user` refused, must end as superseded for `publisher login changed`. The second-round test changed login and permission together, so skipping the login comparison when the current login is unknown passed every case.

A new crash case refuses `/user` after the crash. Skipping the login comparison for an unknown current login now fails it. The test uses a fake GitHub transport.
