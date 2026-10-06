# Aggregate Enola policy bound

The fourth Melian round on [pull request #89](https://github.com/melian-agent/melian/pull/89) found no regression for the aggregate policy limit.
Real revision fixtures now load exactly 1 MiB, then reject an additional one byte or 230 KiB.
Every file remains within the independent 256 KiB bound.
Deleting the aggregate guard passes the old three suites and fails both new cases.
The restored core suite passes.
