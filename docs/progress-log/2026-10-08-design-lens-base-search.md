# Base search discovers the design baseline independently of head terms

Search now accepts revision base. It uses the same match and byte bounds and untrusted boundary as head search, and still uses base attributes on both sides. Tests search a deleted path and renamed terms, check default and explicit head behaviour, and exercise the 200-match bound and one past it.

The design prompt uses base index paths and titles to choose candidates before searching. It follows inactive Supersedes targets to their active successors. Mutation proofs and validation are recorded in tmp/design-lens-followup-report.md.
