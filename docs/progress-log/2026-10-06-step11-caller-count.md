# Independent caller-count cap

The fourth Melian round on [pull request #89](https://github.com/melian-agent/melian/pull/89) found that long paths reached the byte cap before the caller-count cap.
A second fixture now delivers exactly 40 of 50 short callers and checks the exact omitted count.
The long-path fixture still checks the independent byte cap.
Deleting the count guard passes the old suites and fails the short-caller regression.
The restored suite passes.
