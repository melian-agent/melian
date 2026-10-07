# The base policy doctor reports

Doctor has no pull request argument. Reading the checkout could report a trust change that has not reached the base.

Doctor reads committed policy from local `origin/HEAD`, then `origin/main`, then `main`. It falls back to committed `HEAD` with a warning that the base is unknown. It names the ref and commit and does not fetch. Refresh the local base refs before a rehearsal.

The resolved token supplies one viewer lookup and one repository permission lookup. Unknown or non-writing permissions warn without failing doctor. Repository permission says nothing about a token's narrower scopes; GitHub enforces those when publication writes.
