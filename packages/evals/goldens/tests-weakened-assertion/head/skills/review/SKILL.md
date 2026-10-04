---
name: review
description: Reviews the current branch with Melian and relays its verdict.
---
Check that Melian is ready:

```bash
melian doctor
```

Bring the upstream up to date, then review the branch against it:

```bash
git fetch origin
melian review origin/main...HEAD
```

Relay the output verbatim.
