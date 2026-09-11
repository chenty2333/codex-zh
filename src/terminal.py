"""Give Codex a terminal for stdout while forwarding its output to the launcher.

Stdin, stderr, the controlling terminal and process group stay inherited, so
native input, raw mode, job control and terminal queries keep using the real TTY.
"""
import errno
import fcntl
import os
import pty
import select
import signal
import subprocess
import sys
import termios
import tty


def main():
    master, slave = pty.openpty()
    original = termios.tcgetattr(0)
    child = None
    # Avoid processing newlines twice: the real terminal handles output flags.
    tty.setraw(slave)

    def resize(*_):
        size = fcntl.ioctl(0, termios.TIOCGWINSZ, b'\0' * 8)
        fcntl.ioctl(master, termios.TIOCSWINSZ, size)
        if child is not None and child.poll() is None:
            child.send_signal(signal.SIGWINCH)

    resize()
    # The native TUI receives keyboard input and process-group signals directly.
    signal.signal(signal.SIGINT, lambda *_: None)
    try:
        child = subprocess.Popen(sys.argv[1:], stdout=slave)
        os.close(slave)
        slave = None
        signal.signal(signal.SIGTERM, lambda *_: child.terminate())
        signal.signal(signal.SIGWINCH, resize)
        while True:
            if not select.select([master], [], [], 0.1)[0]:
                if child.poll() is not None:
                    break
                continue
            try:
                data = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not data:
                break
            sys.stdout.buffer.write(data)
            sys.stdout.buffer.flush()
        code = child.wait()
        return code if code >= 0 else 128 - code
    finally:
        if child is not None and child.poll() is None:
            child.terminate()
            try:
                child.wait(timeout=4)
            except subprocess.TimeoutExpired:
                child.kill()
                child.wait()
        termios.tcsetattr(0, termios.TCSADRAIN, original)
        os.close(master)
        if slave is not None:
            os.close(slave)


if __name__ == '__main__':
    sys.exit(main())
