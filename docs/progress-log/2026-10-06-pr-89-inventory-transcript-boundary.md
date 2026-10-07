# test(pipeline): exclude lines outside transcript boundaries

For [pull request #89](https://github.com/melian-agent/melian/pull/89), A forged numbered line after the closing tag must not count as delivered evidence. Removing the body end bound fails; all 17 restored artifact tests pass.
