# Mutant output shares core’s terminal escaping

Amends: [mutation evidence](2026-10-24-mutation-evidence-by-enumeration-and-verification.md), terminal rendering of inventories, samples and failures

Problem: the compatibility script escaped samples but left table cells, ordinary JSON and failures exposed to terminal controls. A child’s stderr could bypass its catch.

Example: a replacement containing a bidi override changed the displayed JSON, while a bad range containing a newline forged another error line.

Apply core’s `visibleText` to every variable table cell and the entire error message, including caller arguments. Pipe child stderr so the catch owns its output. JSON uses stringify, split on structural LF, map `visibleText`, then join with LF. This preserves parsed values, legacy shapes, delimiters, counts and exit codes. Constant help text and validated counts need no escaping.

The rule applies to the main CLI and every compatibility list, sample and error route. It introduces no renderer or control-character table.
