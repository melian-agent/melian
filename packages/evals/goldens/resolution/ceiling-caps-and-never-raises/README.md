# A ceiling caps a mapping in its file, and never raises one

A ceiling in a file caps a mapping in that file, and never raises one. The root table maps P1 to `block` and P3 to `advisory`, and the cleanup entry sets `ceiling: acknowledge`. The P1 finding is capped at `acknowledge`. The P3 finding stays `advisory`.
