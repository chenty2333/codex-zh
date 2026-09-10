import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { sse, completedResponse } from '../test/helpers.mjs';

let translatedInputSeen = false, userInputTranslations = 0;
const http = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  let body = ''; for await (const bytes of req) body += bytes;
  const value = JSON.parse(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (req.url === '/responses') {
    if (value.instructions.includes('into English') && value.input === '请测试翻译桥接。') userInputTranslations++;
    const translated = value.instructions.includes('into English') ? value.input.replaceAll('请测试翻译桥接。', 'Please test the translation bridge.') : value.input.replaceAll('The bridge is ready.', '桥接已就绪。');
    res.end(sse(translated)); return;
  }
  translatedInputSeen ||= JSON.stringify(value.input).includes('Please test the translation bridge.');
  const response = completedResponse('The bridge is ready.');
  Object.assign(response, { object: 'response', model: value.model, created_at: Math.floor(Date.now() / 1000), usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } });
  response.output[0].phase = 'final_answer';
  const item = response.output[0];
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
    { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: item.id, delta: 'The bridge is ready.' },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response },
  ];
  res.end(events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join(''));
});
await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${http.address().port}`;
const project = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workspace = resolve(project, '.test-state/tui/workspace');
await mkdir(workspace, { recursive: true });
async function syntheticHistoryEntries() {
  try {
    const history = await readFile(resolve(process.env.CODEX_HOME || `${homedir()}/.codex`, 'history.jsonl'), 'utf8');
    return history.split('\n').filter(line => { try { return JSON.parse(line).text === '请测试翻译桥接。'; } catch { return false; } }).length;
  } catch (error) { if (error.code !== 'ENOENT') throw error; return 0; }
}
const previousHistoryEntries = await syntheticHistoryEntries();
const providerArgs = [
  '-c', `projects.${JSON.stringify(project)}.trust_level="trusted"`,
  '-c', `projects.${JSON.stringify(workspace)}.trust_level="trusted"`,
  '-c', 'model_provider="codex_zh_tui_test"',
  '-c', 'model_providers.codex_zh_tui_test.name="Codex ZH TUI Test"',
  '-c', `model_providers.codex_zh_tui_test.base_url=${JSON.stringify(`${url}/v1`)}`,
  '-c', 'model_providers.codex_zh_tui_test.wire_api="responses"',
  '-c', 'model_providers.codex_zh_tui_test.requires_openai_auth=false',
  '-c', 'model_providers.codex_zh_tui_test.supports_websockets=false',
  '-c', 'model="gpt-5.1-codex-mini"',
];
const nativeArgs = ['--no-alt-screen', '-C', workspace, ...providerArgs];
const codexBin = process.env.CODEX_ZH_CODEX_BIN || 'codex';
async function nativeClient() {
  const child = spawn(codexBin, ['app-server', '--stdio', ...providerArgs], { stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout }), pending = new Map();
  let nextId = 0;
  const send = message => child.stdin.write(JSON.stringify(message) + '\n');
  lines.on('line', line => {
    const message = JSON.parse(line);
    if (message.method) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id); clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message)); else entry.resolve(message.result);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)); }, 15000);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
  try { await request('initialize', { clientInfo: { name: 'codex_zh_tui_verify', version: '0.1.0' }, capabilities: { experimentalApi: true } }); }
  catch (error) { child.kill(); throw error; }
  send({ method: 'initialized' });
  return { request, close() { lines.close(); child.stdin.end(); child.kill(); } };
}
async function runTui(args, stage, { allowHistory = false, directNative = false, pickerName, fixtureName } = {}) {
  const directory = resolve(project, '.test-state/tui', stage);
  const commandArgs = directNative ? [codexBin] : [process.execPath, 'bin/codex-zh.mjs', '--'];
  const prompt = pickerName ? [] : [directNative ? 'Please test the translation bridge.' : '请测试翻译桥接。'];
  const child = spawn('python3', ['scripts/tui-driver.py', ...commandArgs, ...args, ...prompt], {
    cwd: project, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, DEEPSEEK_API_KEY: 'test-credential', DEEPSEEK_BASE_URL: url, CODEX_ZH_TUI_REPORT_DIR: directory, CODEX_ZH_TUI_ALLOW_HISTORY: allowHistory ? '1' : '0', CODEX_ZH_TUI_NATIVE: directNative ? '1' : '0', CODEX_ZH_TUI_PICKER_NAME: pickerName || '', CODEX_ZH_TUI_FIXTURE_NAME: fixtureName || '' },
  });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, `Native TUI ${stage} verification failed; inspect ${directory}/capture.log`);
  const capture = await readFile(resolve(directory, 'capture.log'), 'utf8');
  if (directNative) {
    const sessionId = capture.match(/\bcodex resume ([0-9a-f-]{36})/)?.[1];
    assert.ok(sessionId, 'Native Codex must print a resumable session ID');
    return { sessionId };
  }
  const command = capture.match(/codex-zh: 恢复本次对话：(codex-zh [^\r\n]+)/)?.[1];
  assert.ok(command, 'The launcher must print a specific reusable resume command after shutdown');
  const argv = JSON.parse(execFileSync('python3', ['-c', 'import json,shlex,sys; print(json.dumps(shlex.split(sys.argv[1])))', command], { encoding: 'utf8' }));
  assert.equal(argv[0], 'codex-zh');
  assert.ok(!argv.includes('-C'), 'The printed command must not require a working-directory argument');
  const sessionId = argv[argv.indexOf('resume') + 1];
  assert.match(sessionId, /^[0-9a-f-]{36}$/);
  if (allowHistory) assert.ok(capture.includes('The bridge is ready.'), 'The saved original reply must be restored');
  return { argv, sessionId };
}
let client;
const fixtures = new Set();
try {
  client = await nativeClient();
  const first = await runTui(nativeArgs, 'start');
  fixtures.add(first.sessionId);
  assert.equal(userInputTranslations, 1);
  // Use the printed command, with the local mock provider options added back.
  const resumed = await runTui([...first.argv.slice(1), '--no-alt-screen', ...providerArgs], 'resume-id', { allowHistory: true });
  assert.equal(resumed.sessionId, first.sessionId);
  assert.equal((await client.request('thread/read', { threadId: first.sessionId })).thread.cwd, workspace, 'ID-only resume from another directory must keep the saved workspace');
  assert.equal(userInputTranslations, 2, 'Resuming must translate the new prompt exactly once');
  const recent = await runTui([...nativeArgs, 'resume', '--last'], 'resume-last', { allowHistory: true });
  assert.equal(recent.sessionId, first.sessionId);
  const fixtureName = `NativeHistory_${Date.now()}`;
  const native = await runTui([...nativeArgs, '-c', 'history.persistence="none"'], 'native-start', { directNative: true, fixtureName });
  fixtures.add(native.sessionId);
  const stored = (await client.request('thread/read', { threadId: native.sessionId })).thread;
  assert.equal(stored.source, 'cli');
  assert.equal(stored.name, fixtureName);
  const picked = await runTui(nativeArgs, 'slash-resume', { pickerName: fixtureName, allowHistory: true });
  assert.equal(picked.sessionId, native.sessionId, 'The in-session /resume picker must reopen the native CLI fixture');
  const plainResumed = await runTui([...nativeArgs, '-c', 'history.persistence="none"', 'resume', first.sessionId], 'native-resume-bridge', { directNative: true });
  assert.equal(plainResumed.sessionId, first.sessionId, 'Plain Codex must also resume a bridge-created session');
  assert.ok(translatedInputSeen, 'The model did not receive the English input');
  assert.equal(userInputTranslations, 4);
  assert.equal(await syntheticHistoryEntries(), previousHistoryEntries, 'The native TUI must not persist the untranslated Chinese prompt in input history');
  console.log('Unmodified native Codex TUI: Chinese prompt → English model input → Chinese rendered reply passed.');
  console.log('Native input-history file: no additional Chinese prompt persisted.');
  console.log('Printed resume command and resume --last reopen the same session after a full launcher restart.');
  console.log('/resume selects a native Codex session and continues translating; native Codex can resume bridge sessions too.');
} finally {
  if (client) {
    for (const threadId of fixtures) await client.request('thread/archive', { threadId }).catch(() => {});
    client.close();
  }
  await new Promise(resolve => http.close(resolve));
}
