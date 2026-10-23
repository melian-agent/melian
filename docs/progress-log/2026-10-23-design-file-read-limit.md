# 2026-10-23: Melian reads a design file up to 1 MiB

Every review of this repository failed before any lens ran: `docs/design.md` had grown to 263,971 bytes, past the 256 KiB cap `DesignSections.load` set on reading it from the base.

The cap only bounds a read of the trusted base. The real budget is the 64 KiB heading index sent to the reviewer, which is unchanged. `designFileLimits` in `packages/decisions/src/design-sections.ts` now names a 1 MiB read limit, used for `docs/design.md` and for each linked section file.

The new test loads a 300,000-byte `docs/design.md`. It failed on `799338b1` with `tooLarge` and passes now. The bound tests for both files moved to 1,048,576 bytes (loads) and 1,048,577 bytes (`tooLarge`). Raising either read to 262,144 or off by one fails them. Splitting `docs/design.md` into `docs/design/` files is a separate follow-up.

Codex's adversarial review of [pull request #174](https://github.com/melian-agent/melian/pull/174) showed that a 1 MiB file of 262,144 short headings took about 2.1 GiB and 9 seconds to build its rows before the 64 KiB index check refused it, and that nothing capped the count of linked files. Fix pass 1 narrows the read to 512 KiB per file with 1 MiB across `docs/design.md` and every linked file, checked as each file is read. It parses `docs/design.md` once and stops collecting rows at the first heading that passes the index bound, refusing with the index message. The "headings omitted" figure now counts the rows collected when it stopped, not every heading. `MarkdownDocument.headings()` still lists a file's headings eagerly, now bounded by the 512 KiB cap.
