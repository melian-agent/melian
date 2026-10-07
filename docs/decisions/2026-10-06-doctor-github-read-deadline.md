# Bound doctor’s GitHub reads

Supersedes: 2026-10-06-doctor-stale-base-warning.md.

Doctor retains the committed-policy precedence, stale local-main warning, unknown HEAD warning and permission rules of the earlier decision. It never fetches.

The complete viewer and permission read has a ten-second deadline, matching the gh token command’s limit. The deadline covers response parsing as well as headers. On expiry it aborts the transport and warns that viewer permission is unknown. The warning leaves exit 0. Even a transport that ignores cancellation cannot hold doctor open.

Tests use separate hanging viewer and permission transports and advance a fake clock to the deadline. They assert the warning, exit 0 and an aborted signal.
