# Required status: recall criterion

Branch `required-status` records the maintainer's criterion in the root `comparison.retirement` policy: recall at least 0.75 over the ten most recent pull requests with a comparison record. Nested and preference files cannot change it. Tests cover defaults, partial overrides and invalid values.

The design, plan and evals guideline now state the number and window. The stats retirement line follows [pull request #72](https://github.com/melian-agent/melian/pull/72), which remains open. The shadow reviewers and required-status switch remain unchanged.
