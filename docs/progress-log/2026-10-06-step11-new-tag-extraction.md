# Constructor and tagged-template extraction

The fourth Melian round on [pull request #89](https://github.com/melian-agent/melian/pull/89) found no syntax fixture for constructors or tagged templates.
A compiler fixture now checks both callee identities, pair kinds, and the measured denominator.
Restricting the walker to ordinary calls passes the old compiler suite and fails the new regression.
The restored suite passes.
