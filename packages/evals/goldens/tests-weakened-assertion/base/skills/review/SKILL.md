---
name: review
description: Reviews the current branch with Melian and relays its verdict.
---
Check that Melian is ready:

```bash
melian doctor
```

Review the branch against its upstream:

```bash
melian review origin/main...HEAD
```

Relay the output verbatim.
