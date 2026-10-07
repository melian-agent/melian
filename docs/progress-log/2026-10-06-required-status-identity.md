# Required status: provider identity

Branch `required-status` exposes the pull request author, viewer login and repository permission through the provider port. Refused reads remain unknown. Tests use the fake GitHub transport and confirm that a refused viewer lookup runs once.
