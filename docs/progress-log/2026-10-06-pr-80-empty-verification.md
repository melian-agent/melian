# Empty verification candidates

[Pull request #80](https://github.com/melian-agent/melian/pull/80) drops the old verifier check and detaches its task when no claims remain. A regression withdraws the sole claim after verification fails, then checks that repeated reruns pass without another verifier request.
