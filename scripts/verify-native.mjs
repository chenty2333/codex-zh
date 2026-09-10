import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.mjs';
import { Store } from '../src/store.mjs';
import { Translator } from '../src/translator.mjs';

// Exercise the real Codex 0.154 app-server with a deterministic local model API.
// No task is delegated to an extra coding agent and no real model generation is needed.
const modelRequests = [];
const modelServer = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); modelRequests.push(request);
  const text = 'The bridge is ready.';
  const message = { type: 'message', id: 'msg_native_test', role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: 'resp_native_test', object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: request.model, output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  const events = [
    { type: 'response.created', response: { ...response, status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item: { ...message, status: 'in_progress', content: [] } },
    { type: 'response.content_part.added', item_id: message.id, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'The bridge ' },
    { type: 'response.output_text.delta', item_id: message.id, output_index: 0, content_index: 0, delta: 'is ready.' },
    { type: 'response.output_text.done', item_id: message.id, output_index: 0, content_index: 0, text },
    { type: 'response.content_part.done', item_id: message.id, output_index: 0, content_index: 0, part: message.content[0] },
    { type: 'response.output_item.done', output_index: 0, item: message },
    { type: 'response.completed', response },
  ];
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
  for (const [sequence_number, event] of events.entries()) res.write(`event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`);
  res.end();
});
await new Promise(resolve => modelServer.listen(0, '127.0.0.1', resolve));
const stateDir = new URL('../.test-state/native/', import.meta.url).pathname;
await mkdir(stateDir, { recursive: true, mode: 0o700 });
const config = { codexBin: process.env.CODEX_ZH_CODEX_BIN || 'codex', model: 'deepseek-flash', baseURL: 'https://api.deepseek.com', batchChars: 1800, passthrough: false };
const store = new Store(stateDir);
const api = { async translate(records, direction) { return records.map(r => direction === 'en' ? r.masked.replaceAll('请测试翻译桥接。', 'Please test the translation bridge.') : r.masked.replaceAll('The bridge is ready.', '翻译桥接已就绪。')); } };
const translator = new Translator(api, store, config);
const upstreamURL = `http://127.0.0.1:${modelServer.address().port}/v1`;
const backendArgs = [
  '-c', 'model_provider="codex_zh_verification"',
  '-c', 'model_providers.codex_zh_verification.name="Codex ZH Verification"',
  '-c', `model_providers.codex_zh_verification.base_url=${JSON.stringify(upstreamURL)}`,
  '-c', 'model_providers.codex_zh_verification.wire_api="responses"',
  '-c', 'model_providers.codex_zh_verification.requires_openai_auth=false',
  '-c', 'model_providers.codex_zh_verification.supports_websockets=false',
  '-c', 'model="gpt-5.1-codex-mini"',
];
const server = await startServer({ config, translator, store, backendArgs, log: console.error });
const socket = new WebSocket(server.url, { headers: { Authorization: `Bearer ${server.token}` } });
const pending = new Map(); let id = 0;
const events = [];
socket.on('message', bytes => {
  const message = JSON.parse(bytes.toString());
  if (!message.method && pending.has(message.id)) {
    const p = pending.get(message.id); pending.delete(message.id);
    if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
  } else if (message.method && message.id !== undefined) {
    socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'No interactive tools are needed by this verification.' } }));
  } else events.push(message);
});
function request(method, params) {
  return new Promise((resolve, reject) => {
    const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params }));
  });
}
const deadline = setTimeout(() => { console.error('Native round-trip timed out.'); socket.terminate(); process.exitCode = 1; }, 45000);
try {
  await once(socket, 'open');
  const initialization = await request('initialize', { clientInfo: { name: 'codex_zh_native_verify', version: '0.1.0' }, capabilities: { experimentalApi: true } });
  assert.ok(initialization.userAgent);
  socket.send(JSON.stringify({ method: 'initialized' }));
  const currentConfig = await request('config/read', { includeLayers: false });
  assert.equal(currentConfig.config.model_provider, 'codex_zh_verification');
  const { thread } = await request('thread/start', { cwd: new URL('..', import.meta.url).pathname, ephemeral: true, model: 'gpt-5.1-codex-mini', modelProvider: 'codex_zh_verification', approvalPolicy: 'never', sandbox: 'read-only' });
  await request('turn/start', { threadId: thread.id, effort: 'low', input: [{ type: 'text', text: '请测试翻译桥接。' }] });
  await new Promise((resolve, reject) => {
    const check = () => {
      const done = events.find(e => e.method === 'turn/completed');
      if (done) { clearInterval(interval); done.params.turn.status === 'completed' ? resolve() : reject(new Error(`Native turn status: ${done.params.turn.status}`)); }
    };
    const interval = setInterval(check, 50); check();
    socket.once('close', () => { clearInterval(interval); reject(new Error('Native connection closed before turn completion')); });
  });
  const sourceRequest = modelRequests.at(-1);
  assert.ok(JSON.stringify(sourceRequest.input).includes('Please test the translation bridge.'));
  const displayed = events.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('');
  assert.equal(displayed, '翻译桥接已就绪。');
  const completed = events.find(e => e.method === 'item/completed' && e.params.item.type === 'agentMessage');
  assert.equal(completed.params.item.text, displayed);
  const userMessage = events.find(e => e.params?.item?.type === 'userMessage');
  if (userMessage) assert.equal(userMessage.params.item.content[0].text, '请测试翻译桥接。');
  const report = { checkedAt: new Date().toISOString(), nativeUserAgent: initialization.userAgent, modelRequests: modelRequests.length, sourceReceivedEnglish: true, clientReceivedChinese: true, canonicalStreamVerified: true, eventMethods: [...new Set(events.map(e => e.method))] };
  await writeFile(`${stateDir}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log('Real Codex app-server → local model Responses API → native events round-trip: passed.');
} finally {
  clearTimeout(deadline); socket.terminate(); await server.close(); await new Promise(resolve => modelServer.close(resolve));
}
