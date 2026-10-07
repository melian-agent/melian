# Fixed external-finding IDs

For [pull request #68](https://github.com/melian-agent/melian/pull/68), round eighteen’s `734b45af939279d1` is confirmed. Changing the final ID hash from SHA-256 to SHA-512 passes all 192 existing tests across core comparison, GitHub threads and pipeline comparison. Those tests compare IDs made by the same implementation or check their shape.

Three fixed-value cases now pin the IDs of a thread, a file finding with a reference and a file finding without one. Expected values were computed independently from the documented length-prefixed fields. The mutation fails all three assertions. Restoring SHA-256 passes all 112 core comparison tests.

The local inventory adds row 479 and links the baseline, mutation and restored-suite logs. No production code or design decision changed in this item.
