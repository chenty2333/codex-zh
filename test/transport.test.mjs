import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EventEmitter, once } from 'node:events';
import { PassThrough } from 'node:stream';
import { WebSocket } from 'ws';
import { startServer } from '../src/server.mjs';
import { Translator } from '../src/translator.mjs';
import { fixture, fakeAPI, deferred } from './helpers.mjs';

test('actual WebSocket → stdio process → Responses translator round-trip preserves native protocol', async t => {
  const { config } = await fixture(t);
  const api = fakeAPI((s, direction) => direction === 'en' ? s.replaceAll('你好', 'Hello') : s.replaceAll('Hello', '你好'));
  const translator = new Translator(api, config);
  const server = await startServer({ config, translator, spawnBackend: () => spawn(process.execPath, [fileURLToPath(new URL('./fake-backend.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'pipe'] }) });
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

test('slow translation bounds queued native frames and then drains a long burst without losing replies', { timeout: 10000 }, async t => {
  const { config } = await fixture(t, { maxLiveItems: 1, maxTextChars: 128, maxBufferedChars: 512 });
  const entered = deferred(), release = deferred(), finished = deferred();
  t.after(() => release.resolve());
  const api = { async translate(text) { entered.resolve(); await release.promise; return text.replaceAll('Hello', '你好'); } };
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, killed: false,
    kill() { this.killed = true; this.exitCode = 0; this.stdout.end(); this.stderr.end(); this.emit('exit', 0); return true; },
  });
  const server = await startServer({ config, translator: new Translator(api, config), spawnBackend: () => child });
  t.after(() => server.close());
  const socket = new WebSocket(server.url, { headers: { Authorization: `Bearer ${server.token}` } });
  t.after(() => socket.terminate());
  let completions = 0, wrongText = false;
  socket.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.method === 'item/completed') {
      completions++;
      wrongText ||= message.params.item.text !== (message.params.item.id === 'first' ? '你好' : 'Hello');
    }
    if (message.method === 'turn/completed') finished.resolve();
  });
  await once(socket, 'open');
  const frame = (method, item) => JSON.stringify({ method, params: { threadId: 'thread', turnId: 'turn', item } }) + '\n';
  child.stdout.write(frame('item/started', { type: 'agentMessage', id: 'first', text: '' }) + frame('item/completed', { type: 'agentMessage', id: 'first', text: 'Hello' }));
  await entered.promise;
  let burst = '';
  for (let i = 0; i < 1000; i++) {
    const item = { type: 'agentMessage', id: `extra-${i}`, text: 'Hello' };
    burst += frame('item/started', { ...item, text: '' });
    burst += JSON.stringify({ method: 'item/agentMessage/delta', params: { threadId: 'thread', turnId: 'turn', itemId: item.id, delta: 'Hello' } }) + '\n';
    burst += frame('item/completed', item);
  }
  burst += JSON.stringify({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } } }) + '\n';
  child.stdout.write(burst);
  await new Promise(resolve => setImmediate(resolve));
  const bridge = [...server.connections][0].bridge;
  assert.ok(bridge.tasks.size > 1 && bridge.tasks.size <= 128);
  assert.ok(child.stdout.isPaused(), 'Native stdout should be paused under queue pressure');
  assert.equal(bridge.retainedItems, 1); assert.ok(bridge.retainedChars <= 512);
  release.resolve(); await finished.promise; await bridge.idle();
  assert.equal(completions, 1001); assert.equal(wrongText, false);
  assert.equal(bridge.retainedChars, 0); assert.equal(bridge.retainedItems, 0);
  assert.equal(bridge.tasks.size, 0);
});
