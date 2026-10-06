# Bound rendered standards and record incomplete coverage

Date: 2026-10-06
Supersedes: 2026-10-06-per-lens-standards-cap.md

Empty sections cost no content bytes but add headings and boundaries. Fifty thousand empty sections rendered more than 6 MiB under the old content-only cap.

The union now bounds the rendered standards to 1 MiB and 1024 sections. It counts UTF-8 headings and trimmed content, reserves 128 bytes per section for boundaries and separators, and 1024 bytes for the lead-in. Tests measure the actual quoted renderer against the bound. Four full-sized files no longer fit together once their headings count.

A per-file union prefers each changed file's nearest scope, including imports from that scope. It drops other scopes first, retaining deepest-first and later-first order within each group. Flat arrays have no per-file chains and retain the old scope priority. Imported paths use their importer's scope. This retains the root-import regression while keeping nearest rules where the host provides chains.

Any omitted standards leave the lens record ended and the verdict not reviewed. The lens still runs and may report findings, but it cannot claim complete coverage. Its note names up to ten paths within 4 KiB and the total omitted count. A host can narrow the lens to reduce its union. Refused imports also use a bounded note.
