# auth-guard-removed

Drop an admin check from the export.

Right levels: `correctness` `deep`, `trust-boundary` `deep`.

A guard that refused non-admins is deleted. What every caller now reaches needs the whole function, and the check decided who may read the data.

The levels are the maintainer's judgement of how closely each lens should look, and a golden is changed only with a note here saying why.
