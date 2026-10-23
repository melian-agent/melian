# 2026-10-23: Melian reads a design file up to 1 MiB

Every review of this repository failed before any lens ran: `docs/design.md` had grown to 263,971 bytes, past the 256 KiB cap `DesignSections.load` set on reading it from the base.

The cap only bounds a read of the trusted base. The real budget is the 64 KiB heading index sent to the reviewer, which is unchanged. `designFileLimits` in `packages/decisions/src/design-sections.ts` now names the read limits, used for `docs/design.md` and for each linked section file.

The new test loads a 300,000-byte `docs/design.md`. It failed on `799338b1` with `tooLarge` and passes now. The bound tests for both files moved to 1,048,576 bytes (loads) and 1,048,577 bytes (`tooLarge`). Raising either read to 262,144 or off by one fails them. Splitting `docs/design.md` into `docs/design/` files is a separate follow-up.

Codex's adversarial review of [pull request #174](https://github.com/melian-agent/melian/pull/174) showed that a 1 MiB file of 262,144 short headings took about 2.1 GiB and 9 seconds to build its rows before the 64 KiB index check refused it, and that nothing capped the count of linked files. Fix pass 1 narrows the read to 512 KiB per file with 1 MiB across `docs/design.md` and every linked file, checked as each file is read. It parses `docs/design.md` once and stops collecting rows at the first heading that passes the index bound, refusing with the index message. The "headings omitted" figure now counts the rows collected when it stopped, not every heading. `MarkdownDocument.headings()` still lists a file's headings eagerly, now bounded by the 512 KiB cap.

A second review found the byte caps still did not bound parsing: a legal 512 KiB file of `# a` lines cost about 1.4 GiB before refusal, and empty linked files cost a read each without using the 1 MiB total. Fix pass 2 adds two structural caps in `DesignSections`. A file with more than 20,000 physical lines (LF, CRLF or lone CR) is refused before `MarkdownDocument.parse`, with the file and its line count. A design that links more than 64 section files is refused before any is read, with the count. `docs/design.md` has 1,206 lines today.

A third review found dense inline Markdown on one line still cost 47 seconds and 634 MiB at 512 KiB, which no byte, line or link cap bounds. Fix pass 3 lowers the per-file read to 320 KiB, close to main's earlier 256 KiB, and keeps the 1 MiB total, the line and link caps and the early index stop; the 263,971-byte `docs/design.md` loads with headroom.

Accepted residual: dense inline Markdown still costs disproportionate time and memory within the caps. The input is the trusted base, main had the same exposure at 256 KiB, and [issue #175](https://github.com/melian-agent/melian/issues/175) tracks the hard-limit fix.
