# fix(pipeline): share the caller-query limit across changed files

For [pull request #89](https://github.com/melian-agent/melian/pull/89), round 21. The limit of 128 caller queries went to symbols in path order, so 130 changed symbols in `docs/` left `src/` unqueried. Queries now take one symbol per file in turn. A test with 130 document symbols and one code symbol failed before the change and passes after it.
