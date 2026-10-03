# Actions continuation

Choice: `workflow_dispatch` with changeset input; `workflow_run` recovery workflow; state index with attempt cap; no scheduled sweep

Why: Event-driven recovery costs nothing idle; a sweep burns minutes for a rare case and can be added later without changing state
