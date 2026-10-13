# Trusted writer requires a base-repository head

Supersedes: [the mutation decision](2026-10-08-mutation-testing-as-a-static-check.md), only for the head writer’s trust.

Problem: a maintainer can open a pull request from another person’s fork. The maintainer’s permission does not prove who controls that head.

Choice: a trusted writer requires the head to live in the base repository, never a fork. The head’s pushing identity must hold write, maintain or admin permission there. Use the author only when GitHub gives no better identity. A pusher without write permission never yields to the author’s permission.

GitHub’s [events API](https://docs.github.com/en/rest/using-the-rest-api/github-event-types) names a push actor, ref and head SHA. Read every available page and use the first push event matching the exact head and branch. No matching event permits the author fallback. A failed event read does not. Event retention and latency can leave the pusher unavailable; that is the accepted cost of the fallback.

Fail closed when the head repository, writer identity or permission cannot be read. The head is refused, the check skips with the reason recorded, and the review is not reviewed. This rule is one of three ways a head may run; [the unconfined decision](2026-10-14-static-checks-run-unconfined.md) records the other two, the reviewer's own checkout and a declared isolated runner, and that no sandbox stands behind any of them.
