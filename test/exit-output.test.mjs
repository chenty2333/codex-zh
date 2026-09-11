import test from 'node:test';
import assert from 'node:assert/strict';
import { ExitOutput } from '../src/exit-output.mjs';

const options = { url: 'ws://127.0.0.1:40283', authEnv: 'CODEX_ZH_BRIDGE_TOKEN' };
const command = `codex --remote ${new URL(options.url).href} --remote-auth-token-env ${options.authEnv}`;
const remote = `Disconnected from this task. Any running work continues.\nReconnect: ${command} resume 01a08dc1-2846-7333-af90-41a02a110554\nStop the current turn: run ${command} agents, select this task, and press ctrl + x.\n`;
const usage = 'total=70,473 input=68,102 (+ 822,272 cached) output=2,371 (reasoning 279)';

function capture() {
  const chunks = [];
  const output = new ExitOutput(bytes => chunks.push(bytes), options);
  return { output, text: () => Buffer.concat(chunks).toString('utf8') };
}

test('exit footer preserves exact token counts across every byte boundary', () => {
  const screen = '\x1b[?25h桥接已就绪。\r\n';
  const bytes = Buffer.from(screen + remote + `Token usage so far: ${usage}\n`);
  for (let split = 0; split <= bytes.length; split++) {
    const { output, text } = capture();
    output.push(bytes.subarray(0, split)); output.push(bytes.subarray(split)); output.end();
    assert.equal(text(), screen + `Token usage: ${usage}\n`);
  }
});

test('empty-session footer and CRLF are handled without invented token usage', () => {
  for (const value of [remote, remote.replaceAll('\n', '\r\n'), (remote + `Token usage so far: ${usage}\n`).replaceAll('\n', '\r\n')]) {
    const { output, text } = capture();
    for (const byte of Buffer.from(value)) output.push(Buffer.from([byte]));
    output.end();
    assert.equal(text(), value.includes('Token usage') ? `Token usage: ${usage}\n` : '');
  }
});

test('a quoted disconnect sentence cannot hold up subsequent interactive frames', () => {
  const header = 'Disconnected from this task. Any running work continues.';
  for (const continuation of ['\x1b[22m\r\n正常回复\x1b[6n', '\nReconnect: a different command', '\nReconnect: ' + command + ' resume not-a-session']) {
    const { output, text } = capture();
    output.push(Buffer.from(header));
    output.push(Buffer.from(continuation));
    assert.equal(text(), header + continuation);
    output.end();
    assert.equal(text(), header + continuation);
  }
});

test('interactive output is immediate and unknown or incomplete summaries survive', () => {
  const { output, text } = capture();
  output.push(Buffer.from('\x1b[4;2H正常输出\x1b[6n'));
  assert.equal(text(), '\x1b[4;2H正常输出\x1b[6n');
  for (const value of [remote.replaceAll('40283', '55555'), remote.slice(0, -10), remote + 'Native error\n', 'Disconnected from']) {
    const current = capture();
    current.output.push(Buffer.from(value)); current.output.end();
    assert.equal(current.text(), value);
  }
  const large = remote + '字'.repeat(20000);
  output.push(Buffer.from(large));
  assert.ok(output.pending.length < 16384);
  output.end();
  assert.equal(text(), '\x1b[4;2H正常输出\x1b[6n' + large);
});
