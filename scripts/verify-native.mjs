import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.mjs';
import { Translator } from '../src/translator.mjs';

// Exercise the real Codex 0.154 app-server with a deterministic local model API.
// No task is delegated to an extra coding agent and no real model generation is needed.
const modelRequests = [];
const modelServer = createServer(async (req, res) => {
  if (req.method !== 'POST' || !req.url.endsWith('/responses')) { res.writeHead(404); res.end(); return; }
  let body = ''; for await (const chunk of req) body += chunk;
  const request = JSON.parse(body); modelRequests.push(request);
  const text = 'The bridge is ready.';
  const message = { type: 'message', id: `msg_native_test_${modelRequests.length}`, role: 'assistant', phase: 'final_answer', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
  const response = { id: `resp_native_test_${modelRequests.length}`, object: 'response', created_at: Math.floor(Date.now() / 1000), status: 'completed', model: request.model, output: [message], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
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
const config = { codexBin: process.env.CODEX_ZH_CODEX_BIN || 'codex', model: 'deepseek-flash', baseURL: 'https://api.deepseek.com', passthrough: false };
let translationCalls = 0;
const api = { async translate(text, direction) { translationCalls++; return direction === 'en' ? text.replaceAll('请测试翻译桥接。', 'Please test the translation bridge.') : text.replaceAll('The bridge is ready.', '翻译桥接已就绪。'); } };
const translator = new Translator(api, config);
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
async function connect() {
  const server = await startServer({ config, translator, backendArgs, log: console.error });
  const socket = new WebSocket(server.url, { headers: { Authorization: `Bearer ${server.token}` } });
  const pending = new Map(), events = [];
  let id = 0;
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (!message.method && pending.has(message.id)) {
      const p = pending.get(message.id); pending.delete(message.id);
      if (message.error) p.reject(new Error(JSON.stringify(message.error))); else p.resolve(message.result);
    } else if (message.method && message.id !== undefined) {
      socket.send(JSON.stringify({ id: message.id, error: { code: -32601, message: 'This verification uses no interactive tools.' } }));
    } else events.push(message);
  });
  socket.on('close', () => { for (const p of pending.values()) p.reject(new Error('Native connection closed')); pending.clear(); });
  function request(method, params) {
    return new Promise((resolve, reject) => {
      const requestId = ++id; pending.set(requestId, { resolve, reject }); socket.send(JSON.stringify({ id: requestId, method, params }));
    });
  }
  await once(socket, 'open');
  const initialization = await request('initialize', { clientInfo: { name: 'codex_zh_native_verify', version: '0.2.0' }, capabilities: { experimentalApi: true } });
  socket.send(JSON.stringify({ method: 'initialized' }));
  return {
    server, socket, request, events, initialization,
    async close() { socket.terminate(); await server.close(); },
  };
}
async function runTurn(connection, threadId) {
  connection.events.length = 0;
  await connection.request('turn/start', { threadId, effort: 'low', input: [{ type: 'text', text: '请测试翻译桥接。' }] });
  await new Promise((resolve, reject) => {
    const check = () => {
      const done = connection.events.find(e => e.method === 'turn/completed');
      if (done) { clearInterval(interval); done.params.turn.status === 'completed' ? resolve() : reject(new Error(`Native turn status: ${done.params.turn.status}`)); }
    };
    const interval = setInterval(check, 50); check();
    connection.socket.once('close', () => { clearInterval(interval); reject(new Error('Native connection closed before turn completion')); });
  });
  assert.ok(JSON.stringify(modelRequests.at(-1).input).includes('Please test the translation bridge.'));
  const displayed = connection.events.filter(e => e.method === 'item/agentMessage/delta').map(e => e.params.delta).join('');
  assert.equal(displayed, '翻译桥接已就绪。');
  const completed = connection.events.find(e => e.method === 'item/completed' && e.params.item.type === 'agentMessage');
  assert.equal(completed.params.item.text, displayed);
  const userMessage = connection.events.find(e => e.params?.item?.type === 'userMessage');
  assert.ok(userMessage, 'Native user echo was not received');
  assert.equal(userMessage.params.item.content[0].text, '请测试翻译桥接。');
  for (const connectionState of connection.server.connections) {
    await connectionState.bridge.idle();
    assert.equal(connectionState.bridge.retainedChars, 0);
    assert.equal(connectionState.bridge.retainedItems, 0);
  }
}
function assertEnglishHistory(thread) {
  const items = thread.turns.flatMap(turn => turn.items);
  assert.ok(items.some(i => i.type === 'userMessage' && i.content.some(p => p.type === 'text' && p.text === 'Please test the translation bridge.')));
  assert.ok(items.some(i => i.type === 'agentMessage' && i.text === 'The bridge is ready.'));
  assert.ok(!JSON.stringify(items).includes('请测试翻译桥接。'));
  assert.ok(!JSON.stringify(items).includes('翻译桥接已就绪。'));
}
let connection;
const deadline = setTimeout(() => { console.error('Native resume verification timed out.'); connection?.socket.terminate(); process.exitCode = 1; }, 90000);
try {
  connection = await connect();
  const nativeUserAgent = connection.initialization.userAgent;
  assert.ok(nativeUserAgent);
  const { thread } = await connection.request('thread/start', { cwd: new URL('..', import.meta.url).pathname, ephemeral: false, model: 'gpt-5.1-codex-mini', modelProvider: 'codex_zh_verification', approvalPolicy: 'never', sandbox: 'read-only' });
  assert.equal(connection.server.resumeSession.id, thread.id);
  assert.equal(connection.server.resumeSession.cwd, thread.cwd);
  await runTurn(connection, thread.id);
  assert.equal(translationCalls, 2);
  const history = await connection.request('thread/read', { threadId: thread.id, includeTurns: true });
  assertEnglishHistory(history.thread);
  if (history.thread.path) {
    const transcript = await readFile(history.thread.path, 'utf8');
    assert.ok(!transcript.includes('请测试翻译桥接。'));
    assert.ok(!transcript.includes('翻译桥接已就绪。'));
  }
  await connection.close();
  connection = await connect();
  const resumed = await connection.request('thread/resume', { threadId: thread.id });
  assert.equal(connection.server.resumeSession.id, thread.id);
  assert.equal(connection.server.resumeSession.cwd, resumed.thread.cwd);
  assertEnglishHistory(resumed.thread);
  assert.equal(translationCalls, 2, 'Resuming old history must not call the translator');
  await runTurn(connection, thread.id);
  assert.equal(translationCalls, 4);
  const after = await connection.request('thread/read', { threadId: thread.id, includeTurns: true });
  assertEnglishHistory(after.thread);
  const report = { checkedAt: new Date().toISOString(), nativeUserAgent, modelRequests: modelRequests.length, sourceReceivedEnglish: true, clientReceivedChinese: true, canonicalStreamVerified: true, freshBackendResumeKeptEnglish: true, newTurnTranslatedAfterResume: true, nativeTranscriptHasNoChineseTranslation: true, retainedTranslationCharsAfterTurn: 0 };
  await writeFile(`${stateDir}/report.json`, JSON.stringify(report, null, 2), { mode: 0o600 });
  // This is only the synthetic session created above; do not alter user sessions.
  await connection.request('thread/archive', { threadId: thread.id });
  console.log('Real native backend restart + resume: English history, Chinese new messages, no retained translation text passed.');
} finally {
  clearTimeout(deadline); await connection?.close(); await new Promise(resolve => modelServer.close(resolve));
}
