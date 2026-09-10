"""Exercise the real terminal UI through a PTY; capture only synthetic test content."""
import errno
import fcntl
import json
import os
from pathlib import Path
import pty
import re
import select
import signal
import struct
import subprocess
import sys
import termios
import time

master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 32, 120, 0, 0))
env = dict(os.environ, TERM='xterm-256color')
process = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, env=env,
                           start_new_session=True,
                           preexec_fn=lambda: fcntl.ioctl(0, termios.TIOCSCTTY, 0))
os.close(slave)
capture = bytearray()
deadline = time.monotonic() + 55
quit_sent = False
translated = False
native = False
trust_handled = False
try:
    while time.monotonic() < deadline:
        readable, _, _ = select.select([master], [], [], 0.1)
        if readable:
            try:
                chunk = os.read(master, 65536)
            except OSError as error:
                if error.errno == errno.EIO:
                    break
                raise
            if not chunk:
                break
            capture.extend(chunk)
            if b'\x1b[6n' in chunk:
                os.write(master, b'\x1b[1;1R')
            if b'\x1b[c' in chunk:
                os.write(master, b'\x1b[?1;2c')
            text = capture.decode('utf8', errors='replace')
            text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', text)
            text = re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)
            native = native or 'OpenAI Codex' in text
            translated = translated or '桥接已就绪。' in text
            if 'Doyoutrustthecontentsofthisdirectory?' in re.sub(r'\s+', '', text) and not trust_handled:
                os.write(master, b'\r')
                trust_handled = True
            if translated and not quit_sent:
                # Avoid the native TUI's burst-paste detection when submitting a slash command.
                time.sleep(0.4)
                for character in '/quit':
                    os.write(master, character.encode())
                    time.sleep(0.025)
                time.sleep(0.4)
                os.write(master, b'\r')
                quit_sent = True
        if process.poll() is not None:
            break
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=4)
    directory = Path('.test-state/tui')
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'capture.log').write_bytes(capture)
    report = {'nativeTuiFound': native, 'trustPromptHandled': trust_handled, 'translatedReplyVisible': translated, 'nativeEnglishReplyLeaked': 'The bridge is ready.' in capture.decode('utf8', errors='replace'), 'exitCode': process.returncode}
    (directory / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    sys.exit(0 if native and translated and not report['nativeEnglishReplyLeaked'] and process.returncode == 0 else 1)
finally:
    os.close(master)
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
