# Step 23b: retain unattributed comparison judgements

Fix for [pull request #162](https://github.com/melian-agent/melian/pull/162), found by branch-diff review.

An unattributed version-1 comparison can still owe a golden. Filtering those records out of `ComparisonSet`’s constructor made the debt disappear from backlog and removed candidate-check evidence. Two tests reproduced both losses before the fix.

Keep every comparison for judgement queries. Filter unattributed records only from round metrics and the comparison counter. Their separate count remains visible. The migration still guesses no round, and no stored shape changes.

The report retains the failing and passing runs and the killing mutations. The whole gate and automated Stryker still need the host where `ps` is allowed. No live model ran.
