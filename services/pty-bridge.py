#!/usr/bin/env python3
"""Minimal zero-dep PTY bridge for Falador web terminal.

Spawns an interactive shell in a real PTY and multiplexes stdin/stdout
as newline-delimited JSON messages with base64-encoded PTY output.
"""

import argparse
import base64
import errno
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import termios
import time


def clamp(val: int, lo: int, hi: int) -> int:
    return max(lo, min(hi, int(val)))


def set_winsize(fd: int, cols: int, rows: int) -> None:
    r = clamp(rows, 1, 1000)
    c = clamp(cols, 1, 1000)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", r, c, 0, 0))


def write_all(fd: int, data: bytes) -> None:
    view = memoryview(data)
    while len(view) > 0:
        try:
            n = os.write(fd, view)
            view = view[n:]
        except BlockingIOError:
            select.select([], [fd], [], 0.1)


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def main() -> int:
    parser = argparse.ArgumentParser(description="Falador PTY bridge")
    parser.add_argument("--cols", type=int, default=80)
    parser.add_argument("--rows", type=int, default=24)
    parser.add_argument("--cwd", type=str, default=os.getcwd())
    parser.add_argument("--shell", type=str, default=os.environ.get("SHELL", "/bin/zsh"))
    args = parser.parse_args()

    cols = clamp(args.cols, 1, 1000)
    rows = clamp(args.rows, 1, 1000)
    cwd = args.cwd
    shell = args.shell or "/bin/zsh"

    master_fd, slave_fd = pty.openpty()
    set_winsize(master_fd, cols, rows)

    env = os.environ.copy()
    env["TERM"] = "xterm-256color"
    env["COLORTERM"] = "truecolor"
    env["LANG"] = "en_US.UTF-8"

    child_pid = os.fork()
    if child_pid == 0:
        try:
            os.close(master_fd)
            os.setsid()
            fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)
            os.dup2(slave_fd, 0)
            os.dup2(slave_fd, 1)
            os.dup2(slave_fd, 2)
            if slave_fd > 2:
                os.close(slave_fd)
            if cwd and os.path.isdir(cwd):
                os.chdir(cwd)
            os.execvpe(shell, [shell, "-i"], env)
        except Exception:
            os._exit(127)

    os.close(slave_fd)

    stop_requested = False

    def handle_signal(_signum, _frame) -> None:
        nonlocal stop_requested
        stop_requested = True

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    stdin_fd = sys.stdin.fileno()
    stdin_buf = b""
    stdin_eof = False

    while not stop_requested:
        read_fds = [master_fd]
        if not stdin_eof:
            read_fds.append(stdin_fd)

        try:
            readable, _, _ = select.select(read_fds, [], [], 0.25)
        except InterruptedError:
            continue
        except (ValueError, OSError):
            break

        if master_fd in readable:
            try:
                chunk = os.read(master_fd, 4096)
            except OSError as e:
                if e.errno in (errno.EIO, errno.EBADF):
                    break
                raise
            if not chunk:
                break
            emit({"type": "output", "data": base64.b64encode(chunk).decode("ascii")})

        if stdin_fd in readable:
            try:
                in_chunk = os.read(stdin_fd, 4096)
            except OSError:
                stdin_eof = True
                break
            if not in_chunk:
                stdin_eof = True
                break
            stdin_buf += in_chunk
            while b"\n" in stdin_buf:
                raw_line, stdin_buf = stdin_buf.split(b"\n", 1)
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                try:
                    msg = json.loads(line)
                except json.JSONDecodeError:
                    continue
                mtype = msg.get("type")
                if mtype == "input":
                    data = msg.get("data")
                    if isinstance(data, str) and data:
                        try:
                            write_all(master_fd, data.encode("utf-8"))
                        except OSError:
                            stop_requested = True
                            break
                elif mtype == "resize":
                    new_cols = clamp(msg.get("cols", cols), 1, 1000)
                    new_rows = clamp(msg.get("rows", rows), 1, 1000)
                    try:
                        set_winsize(master_fd, new_cols, new_rows)
                        os.kill(child_pid, signal.SIGWINCH)
                    except (OSError, ProcessLookupError):
                        pass

    exit_code = 0
    try:
        waited_pid, status = os.waitpid(child_pid, os.WNOHANG)
    except ChildProcessError:
        waited_pid, status = child_pid, 0

    if waited_pid == 0:
        for target_pid in (-child_pid, child_pid):
            try:
                os.kill(target_pid, signal.SIGTERM)
            except (OSError, ProcessLookupError):
                pass
        deadline = time.monotonic() + 0.5
        while time.monotonic() < deadline:
            try:
                waited_pid, status = os.waitpid(child_pid, os.WNOHANG)
            except ChildProcessError:
                waited_pid, status = child_pid, 0
                break
            if waited_pid != 0:
                break
            time.sleep(0.02)
        if waited_pid == 0:
            for target_pid in (-child_pid, child_pid):
                try:
                    os.kill(target_pid, signal.SIGKILL)
                except (OSError, ProcessLookupError):
                    pass
            try:
                waited_pid, status = os.waitpid(child_pid, 0)
            except ChildProcessError:
                status = 0

    if os.WIFEXITED(status):
        exit_code = os.WEXITSTATUS(status)
    elif os.WIFSIGNALED(status):
        exit_code = 128 + os.WTERMSIG(status)

    try:
        os.close(master_fd)
    except OSError:
        pass

    emit({"type": "exit", "code": exit_code})
    return 0


if __name__ == "__main__":
    sys.exit(main())
