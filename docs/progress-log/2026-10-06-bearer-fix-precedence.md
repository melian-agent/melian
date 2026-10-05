# Usable named credential precedence

Named credential selection now skips stale bearers and checks the next named value before Pi's store. Planning, reads and listing share that selection. Tests cover a stale per-clone bearer followed by a fresh user bearer, with and without a Pi login.
