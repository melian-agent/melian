# Proven test calls count

Confirmed Claude L5 and Melian 3f06e7d77774e803 on [pull request #89](https://github.com/melian-agent/melian/pull/89). Explicit calls and instantiates now count in test files. Tests assert facts-only and combined numerators, with non-call and wrong-ID controls. They also prove ef7c07f66cdab217 by removing fact matching. Matcher identity advances to avoid reusing older results. The spike records why its historical figures stay unchanged.
