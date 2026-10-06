# Nested function-value identities

The fourth Melian round on [pull request #89](https://github.com/melian-agent/melian/pull/89) found that enclosing arrows lost their bindings.
CompilerGraph now uses binding names for enclosing arrows and function expressions, including named expressions.
A two-file fixture measures both explicit call edges and checks qualified declaration names.
The regression fails on the old code and passes after the fix.
