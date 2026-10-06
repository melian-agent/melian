# Guard the clone's import exclusions

[Pull request #85](https://github.com/melian-agent/melian/pull/85), fourteenth round, finding a7fd062b27731515. Repository ignore fixtures did not protect the clone's core.excludesFile setting.

Both readers already honour local exclusions. The import safety decision requires this: the maintainer controls the clone, and its exclusions can protect private files. The design and core guideline now name core.excludesFile explicitly. No design decision or production behaviour changes.

A real repository fixture sets core.excludesFile through the isolated git environment to an external file. It force-adds private.md and imports it through AGENTS.md. Both sources must report refusal before readText and omit the private content. Disabling core.excludesFile in both readers passes all 136 previous standards cases and fails both new cases. Local evidence is in tmp/fix85n-report.md and tmp/inv85-inventory.md.
