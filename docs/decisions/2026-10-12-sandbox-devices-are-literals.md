# Sandbox device reads use literals

Supersedes: none.

Problem: allowing the whole /dev subtree let head code open the reviewer’s pseudo-terminals. Denying /dev/tty alone left each /dev/ttys device readable.

Choice: seatbelt grants device reads only to /dev/null, /dev/zero, /dev/random, /dev/urandom and /dev/dtracehelper. Null discards output; zero supplies zero-filled bytes. Random and urandom supply entropy. Dtracehelper supports the macOS runtime’s tracing registration. Writes reach null and dtracehelper only; ioctl reaches dtracehelper only. No fd alias is needed by the current command, so none is granted.

Keep the explicit /dev/tty read and write deny. A host probe receives a controlling terminal and its slave path. Both opens must succeed outside seatbelt and fail inside it. Bubblewrap mounts a private /dev in its own namespace, so host terminal paths are absent.

A portable test checks generated profile parentheses outside quoted strings. An extra closing parenthesis fails that test without starting a sandbox.

[Pull request #98](https://github.com/melian-agent/melian/pull/98) closes this device exposure.
