# test(pipeline): prove coverage cache cleanup and symlink refusal

For [pull request #89](https://github.com/melian-agent/melian/pull/89), Six coverage cache cases prove byte-identical symlink refusal, handle closure, failed-write cleanup and explicit matcher identity. All four uncovered mutations fail; the restored suite passes.
