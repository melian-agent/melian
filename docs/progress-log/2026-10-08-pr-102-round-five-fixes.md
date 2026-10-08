# Round five fixes for [pull request #102](https://github.com/melian-agent/melian/pull/102)

“fix(decisions): resolve complete Markdown supersession destinations” fixes f78868db8092038b. CommonMark parsing separates local destination paths from labels, titles, fragments and queries, including reference links and encoded paths. Forty parser tests pass alone. All seventeen parser mutations fail, covering each new branch and the former title-scanning behaviour. The mutation inventory is tmp/fix102-round5-mutations.md. The full gate will run after the second finding’s test is complete.
