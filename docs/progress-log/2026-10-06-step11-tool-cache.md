# Step 11: verified executables

Built `ToolCache` with a faked fetch and tests for digest mismatch, links, parent traversal, absence, young releases, unsupported platforms, and swapped cache files. Entries carry executable hashes and are checked before each use. The static check, graph cache, and coverage measurement remain in progress.

Fix pass: cached executable identity now comes from the retained, manifest-verified archive. A regression swaps both binary and receipt and proves readiness rejects the forgery. Archive corruption is also a miss. Old entries without retained archives repair through fetch.

Fix pass: downloads and repairs publish into unique entry directories, preserving every returned executable path. A barrier forces two cold downloads to overlap and checks that neither publication nor repair removes an entry. The publication decision records the extra cache space and deferred pruning.
