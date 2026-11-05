# Set aside files whose parser lines differ from Git lines

Amends: [mutation evidence](2026-10-24-mutation-evidence-by-enumeration-and-verification.md), enumeration selection for non-Git line separators

Problem: Git counts LF lines, while the TS/JS parser also counts lone CR, U+2028 and U+2029.
Example: a separator on Git line 1 shifts unchanged `y > 1` onto parser line 3. Selecting changed Git line 3 mutates that expression instead of `x + 1`.

After a bounded committed read, enumeration checks the decoded text for these separators anywhere, including comments and strings.
It sets aside the whole file with core's constant `mutationUnmutated.lineBreaks` reason before retaining or instrumenting it.
LF and ordinary CRLF remain supported. There is no offset mapping, language classifier or inventory field.
Mixed selections enumerate only safe files. An entirely set-aside selection has `adapters: []` and every unmutated note.
The existing language scope, `targets.judges` and unsupported-language rules remain intact.

`static.mutation` remains unchanged in this pass. The instrumenter probe uses its same range object, confirmed by installed Stryker's `project-reader.js`.
That probe demonstrates the coordinate mismatch, including unchanged-code mutants. It is not an end-to-end static run.
A real static reproduction and a ruling on changing that check's outcomes remain follow-up work.
