# Sandbox device reads use literals

Supersedes: none.

Problem: allowing the whole /dev subtree let head code open the reviewer’s pseudo-terminals. Denying /dev/tty alone left each /dev/ttys device readable.

Choice: seatbelt grants device reads only to /dev/null and /dev/urandom. Null discards output; urandom supplies entropy to programs that seed from a device. Writes reach null only, and no ioctl is granted. No fd alias is needed by the current command, so none is granted. The first list also held /dev/zero, /dev/random and /dev/dtracehelper; [the grants decision](2026-10-13-seatbelt-profile-grants.md) removed them, since no command failed without them.

Keep the explicit /dev/tty read and write deny. A host probe receives a controlling terminal and its slave path. Both opens must succeed outside seatbelt and fail inside it. Bubblewrap mounts a private /dev in its own namespace, so host terminal paths are absent.

A portable test checks generated profile parentheses outside quoted strings. An extra closing parenthesis fails that test without starting a sandbox.

[Pull request #98](https://github.com/melian-agent/melian/pull/98) closes this device exposure.
