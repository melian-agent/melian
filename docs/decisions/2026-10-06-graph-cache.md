# Graph cache identity

The key hashes tree, Enola version, extracted executable digest, and base policy hash with NUL separators. Graphs share the binary cache's root. A snapshot stores the three contract artifacts, entry hashes, and upstream's optional snapshot.meta.json and run.json. Those two files support upstream snapshot restoration; Melian does not reconstruct the graph.

Every read checks the key parts, receipt format and identity, and artifact hashes. An unreadable entry is a miss. Publication renames a complete temporary directory. No timestamp expires an entry. Check records name the cache key and snapshot ID separately. A hit restores artifacts into execution scratch; it never restores a committed baseline.
