# Explicit trust for publication

Supersedes: 2026-10-06-publisher-attribution-resume.md.

Publication retains the earlier attribution and resume rules. Every public publish caller must supply the committed root writer-trust policy explicitly. The API requires it and rejects omission before any write. Only version-1 publish task and legacy publisher and published document migrations default to trusted writers.

The CLI reads base policy. Tests cover a base refusing writer trust while the head enables it, error status and text with exit 0, and a trusted clean review producing success.
