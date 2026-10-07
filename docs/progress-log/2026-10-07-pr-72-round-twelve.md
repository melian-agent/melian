# Pull request 72, round twelve

- `ComparisonExport.renderJson` passed reviewer text to the terminal through `JSON.stringify`, which leaves C1 controls, bidi controls, and U+2028 and U+2029 raw. It now writes each as a JSON `\uXXXX` escape, so the output is safe on a terminal and parses to the same value. A test reverts to failing.
- The round-eleven entry linked [pull request #72](https://github.com/melian-agent/melian/pull/72) only in part; the bare mention is now a link.
- The private `ComparisonSet.titleOf` lost its TSDoc, which belongs to exported API only.
