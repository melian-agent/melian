# Every design baseline instruction follows active successors

The final scope sentence still said to judge a replacement against the text it supersedes, without qualifying that text as active at base. It now follows the same rule as step 1: inactive targets lead to their successors, whose active base texts supply the baseline.

The design version pin is 100f4163cc7e. The prompt contract test passes and fails when only the active-successor wording is reverted, independently of the version-pin test. No runtime guard or branch changed. The whole gate will run again on this prompt; the earlier completed gate passed before the branch review fixes.
