# Callers of same-line declarations

Confirmed fifth-round finding 4e5e4607c3236390 for [pull request #89](https://github.com/melian-agent/melian/pull/89).
The caller selector dropped every declaration but the last when their start lines matched.
Use the next distinct start line as their shared boundary.

Both regressions fail before the fix: a hunk at the shared start or in the following body returns only b's callers.
The fix returns a's and b's distinct callers and excludes the next declaration outside the hunk.
The runner suite passes all 40 tests, including the existing deletion and next-declaration boundary regression.
