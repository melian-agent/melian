# Step 23a pass 9: prove superseded tasks preserve the saved round

[Pull request #152](https://github.com/melian-agent/melian/pull/152), finding `24338f093b0a403f`.

The superseded-adjudication test now clones the saved round before running the stale task. It asserts that the verdict, provenance and task ownership stay unchanged.

Moving `RoundWriter.record` above the ownership guard passes the old test. The same mutation fails the strengthened test: provenance changes, the stale task joins the task list and the saved verdict becomes not reviewed. Restoring the source passes. No production change is needed.
