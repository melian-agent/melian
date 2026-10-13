# A file that writes a table overrides a lens's declared ceiling, and restating the ceiling keeps it

A file that writes a table overrides a lens's declared ceiling, with its doctor line, and restating the ceiling keeps it. The cleanup lens declares `ceiling: advisory`. The root writes `P2: acknowledge`, so a P2 cleanup finding now needs an acknowledgement. The file in `kept/` writes the same table and restates the ceiling, so its finding stays `advisory`, and doctor has no line for it.
