[Pull request #310](https://github.com/melian-agent/melian/pull/310), fixes for Codex's adversarial review of edc438b. Each began with a test that failed on edc438b for the reported reason.

- Nothing proved a clone held the branch's key, so a clone with another key could add a changeset no other writer could open, or rewrite its cached copy under its own key. The index now carries an HMAC commitment to the key, written by the first push and checked on every read before a lease or a push.
- A holder outside the index's 1 to 200 characters was written into a lease that the next read refused, which would have made every changeset unavailable. The constructor now refuses it, with `invalidHolder`, before any git command.
