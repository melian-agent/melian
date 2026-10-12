import os, pty, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
out = b""
try:
    while True:
        data = os.read(fd, 4096)
        if not data:
            break
        out += data
except OSError:
    pass
os.waitpid(pid, 0)
sys.stdout.buffer.write(out)
