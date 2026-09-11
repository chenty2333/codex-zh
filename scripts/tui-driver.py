"""Exercise real native terminal sessions and the /resume picker through a PTY."""
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
trust_handled = False
native_mode = env.get('CODEX_ZH_TUI_NATIVE') == '1'
allow_history = native_mode or env.get('CODEX_ZH_TUI_ALLOW_HISTORY') == '1'
picker_name = env.get('CODEX_ZH_TUI_PICKER_NAME')
fixture_name = env.get('CODEX_ZH_TUI_FIXTURE_NAME')
history_prompt = env.get('CODEX_ZH_TUI_HISTORY_PROMPT')
history_recalled = False
history_empty_restored = False
picker_opened = False
workflow_complete = False
error_message = None


def visible(start=0):
    text = capture[start:].decode('utf8', errors='replace')
    text = re.sub(r'\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)', '', text)
    return re.sub(r'\x1b\[[0-?]*[ -/]*[@-~]', '', text)


def read_output():
    global trust_handled
    readable, _, _ = select.select([master], [], [], 0.1)
    if not readable:
        return process.poll() is None
    try:
        chunk = os.read(master, 65536)
    except OSError as error:
        if error.errno == errno.EIO:
            return False
        raise
    if not chunk:
        return False
    capture.extend(chunk)
    if b'\x1b[6n' in chunk:
        os.write(master, b'\x1b[1;1R')
    if b'\x1b[c' in chunk:
        os.write(master, b'\x1b[?1;2c')
    if not trust_handled and 'Doyoutrustthecontentsofthisdirectory?' in re.sub(r'\s+', '', visible()):
        time.sleep(0.4)
        os.write(master, b'\r')
        trust_handled = True
    return True


def wait_for(text, start=0, compact=False):
    while time.monotonic() < deadline:
        actual = visible(start)
        # Cursor-positioned redraws can omit spaces from the raw PTY stream.
        matches = re.sub(r'\s+', '', text) in re.sub(r'\s+', '', actual) if compact else text in actual
        if matches:
            return
        if not read_output():
            break
    raise RuntimeError(f'TUI did not show {text!r}')


def drain_for(seconds):
    end = min(deadline, time.monotonic() + seconds)
    while time.monotonic() < end and read_output():
        pass


def type_text(text):
    # Avoid the native TUI's burst-paste detection for slash commands.
    time.sleep(0.4)
    for character in text:
        os.write(master, character.encode())
        time.sleep(0.025)
    time.sleep(0.4)


def send_line(text):
    type_text(text)
    os.write(master, b'\r')


try:
    try:
        wait_for('OpenAI Codex')
        if history_prompt:
            wait_for('gpt-5.1-codex-mini')
            drain_for(1)
            start = len(capture)
            os.write(master, b'\x1b[A')
            wait_for(history_prompt, start, compact=True)
            history_recalled = True
            start = len(capture)
            os.write(master, b'\x1b[B')
            wait_for('Ask Codex to do anything', start, compact=True)
            history_empty_restored = True
            start = len(capture)
            os.write(master, b'\x1b[A')
            wait_for(history_prompt, start, compact=True)
            os.write(master, b'\x15')
            send_line('Please test the translation bridge.' if native_mode else '请测试翻译桥接。')
        if picker_name:
            wait_for('gpt-5.1-codex-mini')
            drain_for(1)
            send_line('/resume')
            wait_for('Resume a previous session')
            picker_opened = True
            wait_for(picker_name, compact=True)
            type_text(picker_name)
            # Wait until the initial rows exist before filtering. The terminal
            # redraws only changed count digits, so raw output has no full 1 / 1.
            drain_for(0.4)
            start = len(capture)
            os.write(master, b'\r')
            wait_for('The bridge is ready.', start)
            start = len(capture)
            send_line('请测试翻译桥接。')
            wait_for('桥接已就绪。', start)
        elif native_mode:
            wait_for('The bridge is ready.')
            if fixture_name:
                send_line('/rename ' + fixture_name)
                drain_for(1)
        else:
            wait_for('桥接已就绪。')
        send_line('/quit')
        while time.monotonic() < deadline and read_output():
            pass
        workflow_complete = True
    except RuntimeError as error:
        error_message = str(error)
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGTERM)
        try:
            process.wait(timeout=4)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait(timeout=4)
    directory = Path(env.get('CODEX_ZH_TUI_REPORT_DIR', '.test-state/tui'))
    directory.mkdir(parents=True, exist_ok=True)
    (directory / 'capture.log').write_bytes(capture)
    text = visible()
    original_visible = 'The bridge is ready.' in text
    report = {'nativeTuiFound': 'OpenAI Codex' in text, 'trustPromptHandled': trust_handled,
              'translatedReplyVisible': '桥接已就绪。' in text,
              'nativeEnglishReplyLeaked': original_visible and not allow_history,
              'originalHistoryVisible': original_visible and allow_history,
              'pickerOpened': picker_opened, 'workflowComplete': workflow_complete,
              'sharedPromptRecalled': history_recalled, 'emptyComposerRestoredWithDown': history_empty_restored,
              'exitCode': process.returncode, 'error': error_message}
    (directory / 'report.json').write_text(json.dumps(report, indent=2))
    print(json.dumps(report))
    sys.exit(0 if workflow_complete and not report['nativeEnglishReplyLeaked'] and process.returncode == 0 else 1)
finally:
    os.close(master)
    if process.poll() is None:
        os.killpg(process.pid, signal.SIGKILL)
