# Prove deleted-author and copied-reply handling

[Pull request #145](https://github.com/melian-agent/melian/pull/145), pass 5.
A deleted-root-author test kills removal of the optional data.user access at provider.ts:463.
A copied finding marker in a reply kills removal of the root-only guard at line 633.
The restored provider suite passes.

The survivor at line 86 replaces only the typeof check with false.
It is equivalent for JSON input: the remaining null check rejects null, and primitives lack an ID.
The first ID check rejects them before their other fields matter.
The grouped optional review-author access at line 463 is also equivalent.
A null review author makes the preceding revision check return before the access.

The four earlier provider equivalents were rerun at lines 547, 548, 557 and 676.
They still fail closed or ignore the inert sentinel.
These equivalences await coordinator adjudication; this pass dismisses nothing.
The exact probes, results and updated line numbers are in `tmp/orphan-thread-pass5-report.md` and `tmp/orphan-thread-equivalents.md`.
No production behaviour or document version changes.
