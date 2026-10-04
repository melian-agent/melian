# Reading scope as an instruction

Choice: A level's `reads: functions` reaches the lens as an instruction in its system prompt: read the whole function, method, or top-level block around each hunk at the head with `read_file`, and review all of it. The change prompt carries the hunks alone at every level. Putting the enclosing functions into the change prompt waits until Melian can find a function's bounds in every language it reviews.

Why: Finding a function's bounds needs a parser for each language. A guess from indentation or braces would cut a function short or swallow its neighbours, and the prompt would then show the model a wrong scope as fact. The instruction lets the model find the bounds with the tools it already has. The reads cost tool calls the level's budget counts, which is one reason `deep`, the only built-in level that reads functions, has the largest tool budget.
