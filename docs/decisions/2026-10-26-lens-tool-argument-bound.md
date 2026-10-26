# Lens tools bound arguments before Pi validates

Amends: [Lens graph tools](2026-10-24-lens-graph-tools.md), argument validation

Status: accepted on 2026-10-26 by the maintainer.

Pi validates arguments before Melian's bounded handlers. A malformed search with a 70,000-character path returned 71,081 bytes. A 3,000-path call returned 3,011 lines. The four graph tools also echoed oversized arguments.

The seven read tools share one `prepareArguments` guard. It refuses arguments whose serialised JSON exceeds 8 KiB. It asks Pi's validator to preflight all remaining calls and replaces any schema failure with a short fixed refusal. This catches excess array items without copying schema bounds. It also catches nested JSON whose pretty-printed error echo grows faster than its input size. Pi's later validation sees arguments its own validator accepted. The fixed refusal fits both output limits and quotes no input.

[Issue #248](https://github.com/melian-agent/melian/issues/248) tracks bounding these errors in Pi itself. Successful tool results retain their existing bounds and prompt boundaries.
