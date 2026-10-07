# Caller context in task selection

A repeat review can acquire caller context after a tool fetch. Attaching to a task that saw no context silently ignores it and measures fresh graph data against old transcripts. Hash each lens’s rendered caller section with a fixed nonce in its selection. Changed context replaces the task; identical context attaches. Query cut-offs affect selection only when they change delivered text. The actual prompt keeps its random nonce.
