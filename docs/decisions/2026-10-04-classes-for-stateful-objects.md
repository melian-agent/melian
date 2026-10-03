# Classes for stateful objects

Choice: Classes for things with identity, state, or a lifecycle, named after the thing, with `close()` where there is something to release; plain functions and readonly data for definitions and transforms; error types are classes with a `code`; never a class as a namespace for static functions, and never a closure standing in for something that should be opened and closed

Why: Pi Durable draws the line there, with `MemoryStorage`, `NodeExecutionEnv`, and `Transaction` as classes and `defineTool`, `defineTask`, and `section` as functions returning data, and Melian follows Pi's conventions wherever it has no reason to differ. A class names the object a reader holds and shows what it owns; a closure over the same state hides both
