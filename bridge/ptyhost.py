#!/usr/bin/env python3
"""Runs a command in a pseudo-terminal for ccm-bridge's terminal (Node has no pty without native code).

    python3 ptyhost.py COLS ROWS COMMAND [ARGS...]

stdin goes to the terminal and the terminal's output to stdout, as raw bytes. Each line on fd 3,
"COLS ROWS", resizes the terminal (the kernel then sends SIGWINCH to the program in front). Exits
with the command's status; if stdin closes (the bridge went away), the command gets SIGHUP.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def set_size(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


def signal_group(pid, sig):
    try:
        os.killpg(pid, sig)
    except ProcessLookupError:
        pass
    except PermissionError:
        try:
            os.kill(pid, sig)
        except ProcessLookupError:
            pass


def main():
    cols, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
    pid, master = pty.fork()
    if pid == 0:
        os.environ.setdefault("TERM", "xterm-256color")
        try:
            os.execvp(argv[0], argv)
        except OSError as e:
            os.write(2, f"Can't start {argv[0]}: {e.strerror}\r\n".encode())
            os._exit(127)
    set_size(master, cols, rows)

    shutdown_at = None

    def handle_term(_signum, _frame):
        nonlocal shutdown_at
        if shutdown_at is None:
            shutdown_at = time.monotonic()
        signal_group(pid, signal.SIGHUP)
        signal_group(pid, signal.SIGTERM)

    signal.signal(signal.SIGTERM, handle_term)
    signal.signal(signal.SIGHUP, handle_term)

    watch = [0, master]
    try:
        os.fstat(3)
        watch.append(3)
    except OSError:
        pass
    ctrl = b""
    while True:
        if shutdown_at is not None and time.monotonic() - shutdown_at >= 1.5:
            signal_group(pid, signal.SIGKILL)
            break
        try:
            timeout = 0.2 if shutdown_at is not None else None
            ready, _, _ = select.select(watch, [], [], timeout)
        except InterruptedError:
            continue
        if master in ready:
            try:
                data = os.read(master, 65536)
            except OSError as e:  # EIO once the command and everything holding the terminal exit
                if e.errno != errno.EIO:
                    raise
                data = b""
            if not data:
                break
            os.write(1, data)
        if 0 in ready:
            data = os.read(0, 65536)
            if not data:
                signal_group(pid, signal.SIGHUP)
                watch.remove(0)
            else:
                os.write(master, data)
        if 3 in ready:
            chunk = os.read(3, 1024)
            if not chunk:
                watch.remove(3)
            ctrl += chunk
            while b"\n" in ctrl:
                line, ctrl = ctrl.split(b"\n", 1)
                try:
                    cols, rows = (int(x) for x in line.split())
                    set_size(master, cols, rows)
                except ValueError:
                    pass  # not a size: ignore it rather than lose the terminal

    _, status = os.waitpid(pid, 0)
    sys.exit(os.waitstatus_to_exitcode(status) if hasattr(os, "waitstatus_to_exitcode") else status >> 8)


if __name__ == "__main__":
    main()
