import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { sse, completedResponse } from '../test/helpers.mjs';

let translatedInputSeen = false, translatorCalls = 0;
const http = createServer(async (req, res) => {
  if (req.method !== 'POST') { res.writeHead(404); res.end(); return; }
  let body = ''; for await (const bytes of req) body += bytes;
  const value = JSON.parse(body);
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  if (req.url === '/responses') {
    translatorCalls++;
    const input = JSON.parse(value.input);
    const translated = { translations: input.segments.map(s => ({ id: s.id, text: input.target_language === 'English' ? s.text.replaceAll('请测试翻译桥接。', 'Please test the translation bridge.') : s.text.replaceAll('The bridge is ready.', '桥接已就绪。') })) };
    res.end(sse(JSON.stringify(translated))); return;
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
async function syntheticHistoryEntries() {
  try {
    const history = await readFile(resolve(process.env.CODEX_HOME || `${homedir()}/.codex`, 'history.jsonl'), 'utf8');
    return history.split('\n').filter(line => { try { return JSON.parse(line).text === '请测试翻译桥接。'; } catch { return false; } }).length;
  } catch (error) { if (error.code !== 'ENOENT') throw error; return 0; }
}
const previousHistoryEntries = await syntheticHistoryEntries();
const nativeArgs = [
  '--no-alt-screen', '-C', project,
  '-c', `projects.${JSON.stringify(project)}.trust_level="trusted"`,
  '-c', 'model_provider="codex_zh_tui_test"',
  '-c', 'model_providers.codex_zh_tui_test.name="Codex ZH TUI Test"',
  '-c', `model_providers.codex_zh_tui_test.base_url=${JSON.stringify(`${url}/v1`)}`,
  '-c', 'model_providers.codex_zh_tui_test.wire_api="responses"',
  '-c', 'model_providers.codex_zh_tui_test.requires_openai_auth=false',
  '-c', 'model_providers.codex_zh_tui_test.supports_websockets=false',
  '-c', 'model="gpt-5.1-codex-mini"',
  '请测试翻译桥接。',
];
try {
  const child = spawn('python3', ['scripts/tui-driver.py', process.execPath, 'bin/codex-zh.mjs', '--', ...nativeArgs], {
    cwd: project, stdio: ['ignore', 'inherit', 'inherit'],
    env: { ...process.env, DEEPSEEK_API_KEY: 'test-credential', DEEPSEEK_BASE_URL: url },
  });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 0, 'Native TUI verification failed; inspect .test-state/tui/capture.log');
  assert.ok(translatedInputSeen, 'The model did not receive the English input');
  assert.ok(translatorCalls >= 2, 'Both translation directions must be exercised');
  assert.equal(await syntheticHistoryEntries(), previousHistoryEntries, 'The native TUI must not persist the untranslated Chinese prompt in input history');
  console.log('Unmodified native Codex TUI: Chinese prompt → English model input → Chinese rendered reply passed.');
  console.log('Native input-history file: no additional Chinese prompt persisted.');
} finally { await new Promise(resolve => http.close(resolve)); }
