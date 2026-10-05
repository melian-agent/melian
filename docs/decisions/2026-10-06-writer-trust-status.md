# Writer trust in CLI publication

The CLI cannot prove that a user-set status came from a trusted host. GitHub lets any writer set the same context.

The committed root policy at the pull request base controls writer trust. With `trust.writers: false`, publication still posts the review and ledger, sets `melian/review` to `error`, prints the reason and exits successfully. Only milestone 3's Actions host will count under this policy.

Each revision records the publisher login, repository permission, author permission and trust setting. Unknown reads stay unknown. Old records default to trusted writers without a known poster. A publish task captures attribution before writing; a changed trust policy supersedes interrupted tasks.

An author without write permission does not block a maintainer publishing a full review. The Actions host must refuse that author's local record in milestone 3. No host or local-record consumer is built here.
