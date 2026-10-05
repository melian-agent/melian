The twelfth review of [pull request #62](https://github.com/melian-agent/melian/pull/62) found that two finite weights near `Number.MAX_VALUE` overflowed their sum. Every option then received probability zero.

`Decision.parse` now scales each weight by the largest before summing. The regression checks unequal weights, a tie, the chosen option, and a total probability of one.
