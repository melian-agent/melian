# 2026-10-22: republishing repairs a superseding status actor

The Codex adversarial review of [pull request #168](https://github.com/melian-agent/melian/pull/168) found a valid publication defect. A newer status could copy the state, base suffix and ledger URL while belonging to a bot or non-writer. Publication skipped its write, but the merge-group command rejected that actor. An authorised maintainer could not repair the gate by republishing.

Four regressions first failed because republishing made no status write. They cover a bot, another user, a matching-login bot, and a deleted creator. A base-qualified status lookup now requires the current user's own User status when `/user` establishes that identity. Republish restores a writer's status without another review. The tests read the resulting creator, base, target and current write permission through the fake API.

An author learned from a posted review may be an installation bot. A separate regression caught repeated bot status writes in the first fix. The provider now distinguishes that author from an authenticated User. Installation-token deduplication remains intact. The fake records the server-assigned status creator and account type rather than deriving them at read time.

The publication and crash suites pass; the eight status tests pass too. Ten hand mutations fail named tests, including every new actor and identity guard. The coordinator still runs the host mutation round and review of record. The companion could not run local commands in its sandbox, so its review was limited.
