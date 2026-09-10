import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.mjs';
import { Translator } from '../src/translator.mjs';
import { fixture, fakeAPI } from './helpers.mjs';

test('actual WebSocket → stdio process → Responses translator round-trip preserves native protocol', async t => {
  const { config, store } = await fixture(t);
  const api = fakeAPI((s, direction) => direction === 'en' ? s.replaceAll('你好', 'Hello') : s.replaceAll('Hello', '你好'));
  const translator = new Translator(api, store, config);
  const server = await startServer({ config, store, translator, spawnBackend: () => spawn(process.execPath, [fileURLToPath(new URL('./fake-backend.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] }) });
  t.after(() => server.close());
  const socket = new WebSocket(server.url, { headers: { Authorization: `Bearer ${server.token}` } });
  t.after(() => socket.terminate());
  const messages = [];
  let complete;
  const completion = new Promise(resolve => { complete = resolve; });
  socket.on('message', bytes => { const m = JSON.parse(bytes.toString()); messages.push(m); if (m.method === 'turn/completed') complete(); });
  await once(socket, 'open');
  socket.send(JSON.stringify({ id: 0, method: 'initialize', params: {} }));
  socket.send(JSON.stringify({ id: 1, method: 'turn/start', params: { threadId: 'thread', input: [{ type: 'text', text: '你好' }] } }));
  await completion;
  const text = messages.filter(m => m.method === 'item/agentMessage/delta').map(m => m.params.delta).join('');
  assert.equal(text, '你好');
  assert.equal(messages.at(-1).params.turn.items[0].text, text);
  assert.equal(messages.find(m => m.params?.item?.type === 'userMessage').params.item.content[0].text, '你好');
  socket.close();
});

test('unauthenticated local clients cannot start or access a backend', async t => {
  let spawns = 0;
  const server = await startServer({ config: {}, spawnBackend: () => { spawns++; throw new Error('Should never spawn'); } });
  t.after(() => server.close());
  const socket = new WebSocket(server.url);
  socket.on('error', () => {});
  const response = await new Promise(resolve => socket.on('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode); socket.terminate(); }));
  assert.equal(response, 401); assert.equal(spawns, 0);
});
