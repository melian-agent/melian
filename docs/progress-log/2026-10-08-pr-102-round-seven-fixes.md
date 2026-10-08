# Design lens round seven fixes

For [pull request #102](https://github.com/melian-agent/melian/pull/102), `fix(design): resolve encoded section links at base` fixes finding 242e9770bc1ab800. Its link table covers inline and reference forms, titles, relative paths, URI encoding, CRLF and missing sections. The resolver checks decoded repository boundaries before filtering sections. All 47 design-section tests passed; 16 link mutations failed. An initial redundant guard survived removal and was removed from the implementation. The full gate awaits the remaining fixes.
