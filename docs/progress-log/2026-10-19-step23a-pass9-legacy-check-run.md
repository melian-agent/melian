# Step 23a pass 9: retain a legacy attachment's check run

[Pull request #152](https://github.com/melian-agent/melian/pull/152), finding `0a08f04ca44dd693`.

Legacy attachments now store the first accepted check-run identity. Later runs compare against it, so a distinct CLI check run mints r1 even when its records match.

The main-written decided SQLite fixture reproduces the defect: the first run attaches, but a second identity leaves the counter at zero. The fixed test mints r1 and preserves the legacy round. Direct writer tests retain the first identity across later writes.

Six hand mutations cover the stored lookup, saving, replacement, caller argument, legacy fallback and minted identity boundary. Each fails the round tests. The pass report records the exact failures and full gate result.
