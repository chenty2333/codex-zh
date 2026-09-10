import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.mjs';
import { Translator } from '../src/translator.mjs';
import { Store } from '../src/store.mjs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fixture, fakeAPI, deferred } from './helpers.mjs';

async function setup(t, api = fakeAPI((s, dir) => dir === 'en' ? s.replaceAll('你好', 'Hello') : s.replaceAll('Hello', '你好').replaceAll('World', '世界')), overrides = {}) {
  const f = await fixture(t, overrides), up = [], down = [];
  const translator = new Translator(api, f.store, f.config);
  const bridge = new Bridge({ translator, store: f.store, config: f.config, sendUp: m => up.push(structuredClone(m)), sendDown: m => down.push(structuredClone(m)) });
  t.after(() => bridge.close());
  return { ...f, api, up, down, translator, bridge };
}

const event = (method, extra = {}) => ({ method, params: { threadId: 'thread', turnId: 'turn', ...extra } });
const start = (text = '', type = 'agentMessage') => event('item/started', { item: { type, id: 'item', text, phase: 'final_answer' } });
const delta = (text, type = 'agentMessage') => event(type === 'plan' ? 'item/plan/delta' : 'item/agentMessage/delta', { itemId: 'item', delta: text });
const finish = (text, type = 'agentMessage') => event('item/completed', { item: { type, id: 'item', text, phase: 'final_answer', memoryCitation: null } });
const done = (text, status = 'completed') => ({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status, items: [{ id: 'item', type: 'agentMessage', text }] } } });
const prompt = () => ({ id: 1, method: 'turn/start', params: { threadId: 'thread', model: 'original-model', input: [{ type: 'text', text: '你好 `file.ts`' }, { type: 'localImage', path: '/example/image.png' }, { type: 'skill', name: 'review', path: '/example/SKILL.md' }] } });

test('passthrough forwards arbitrary requests, tool replies, deltas, and future events unchanged', async t => {
  const { bridge, up, down } = await setup(t, fakeAPI(), { passthrough: true });
  const request = prompt(), response = { id: 5, result: { answers: { q: { answers: ['Accept'] } } } };
  await bridge.fromClient(request); await bridge.fromClient(response);
  await bridge.fromServer(delta('Hello')); await bridge.fromServer({ method: 'future/new', params: { arbitrary: ['中文'] } });
  assert.deepEqual(up, [request, response]);
  assert.equal(down[0].params.delta, 'Hello'); assert.equal(down[1].params.arbitrary[0], '中文');
});

test('only prompt text changes; attachments, skills, model settings, and original user echo survive', async t => {
  const { bridge, up, down } = await setup(t);
  const original = prompt(); await bridge.fromClient(original);
  assert.equal(up[0].params.model, 'original-model');
  assert.equal(up[0].params.input[0].text, 'Hello `file.ts`');
  assert.deepEqual(up[0].params.input.slice(1), original.params.input.slice(1));
  await bridge.fromServer(event('item/completed', { item: { type: 'userMessage', id: 'user', clientId: up[0].params.clientUserMessageId, content: up[0].params.input } }));
  assert.deepEqual(down.at(-1).params.item.content, original.params.input);
});

test('failed input translation is never submitted', async t => {
  const api = { async translate() { throw new Error('Failure'); } };
  const { bridge, up, down } = await setup(t, api);
  await bridge.fromClient(prompt());
  assert.equal(up.length, 0); assert.equal(down[0].id, 1); assert.equal(down[0].error.code, -32001);
});

test('native default fields on user-message echoes do not lose the original Chinese prompt', async t => {
  const { bridge, up, down } = await setup(t);
  const original = prompt(); await bridge.fromClient(original);
  const normalized = structuredClone(up[0].params.input);
  normalized[0].text_elements = [];
  normalized[1].detail = null;
  await bridge.fromServer(event('item/completed', { item: { type: 'userMessage', id: 'normalized-user', clientId: up[0].params.clientUserMessageId, content: normalized } }));
  assert.deepEqual(down.at(-1).params.item.content, original.params.input);
});

test('authoritative source wins over different source deltas; displayed chunks exactly equal completed item and turn', async t => {
  const { bridge, down, api } = await setup(t);
  await bridge.fromServer(start()); await bridge.fromServer(delta('incorrect provisional text'));
  assert.ok(!down.some(m => m.method.endsWith('/delta')));
  bridge.fromServer(finish('Hello\nWorld')); bridge.fromServer(done('Hello\nWorld'));
  await bridge.idle();
  const displayed = down.filter(m => m.method === 'item/agentMessage/delta').map(m => m.params.delta).join('');
  assert.equal(displayed, '你好\n世界');
  assert.equal(down.find(m => m.method === 'item/completed').params.item.text, displayed);
  assert.equal(down.find(m => m.method === 'turn/completed').params.turn.items[0].text, displayed);
  assert.equal(api.calls.length, 1);
});

test('approvals, tool output, and interrupt bypass a slow translation; remainder is preserved', async t => {
  const entered = deferred();
  const api = { async translate(_records, _direction, { signal }) {
    entered.resolve(); return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } };
  const { bridge, up, down } = await setup(t, api);
  await bridge.fromServer(start()); bridge.fromServer(finish('Hello'));
  await entered.promise;
  const approval = { id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: 'thread', command: 'echo hello', itemId: 'tool' } };
  await bridge.fromServer(approval);
  const log = event('item/commandExecution/outputDelta', { itemId: 'tool', delta: 'raw output' });
  await bridge.fromServer(log);
  assert.deepEqual(down.at(-2), approval); assert.deepEqual(down.at(-1), log);
  await bridge.fromClient({ id: 'approval', result: { decision: 'accept' } });
  const interrupt = { id: 2, method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } };
  await bridge.fromClient(interrupt); await bridge.idle();
  assert.deepEqual(up.at(-1), interrupt);
  assert.equal(down.find(m => m.method === 'item/completed').params.item.text, 'Hello');
});

test('interrupt cancels a prompt still waiting for translation', async t => {
  const entered = deferred();
  const api = { async translate(_r, _d, { signal }) { entered.resolve(); return new Promise((_a, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true })); } };
  const { bridge, up, down } = await setup(t, api);
  bridge.fromClient(prompt()); await entered.promise;
  await bridge.fromClient({ id: 2, method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } });
  await bridge.idle();
  assert.equal(up.length, 1); assert.equal(up[0].method, 'turn/interrupt');
  assert.ok(down.some(m => m.id === 1 && m.error));
});

test('output validation failure preserves source for that batch and keeps the displayed prefix consistent', async t => {
  let count = 0;
  const api = { async translate(records) { count++; return records.map(r => count === 1 ? r.masked.replace('Hello', '你好') : 'bad `injected code`'); } };
  const { bridge, down } = await setup(t, api, { batchChars: 1 });
  await bridge.fromServer(start()); await bridge.fromServer(finish('Hello\nWorld'));
  const displayed = down.filter(m => m.method.endsWith('/delta')).map(m => m.params.delta).join('');
  assert.equal(displayed, '你好\nWorld'); assert.equal(down.at(-1).params.item.text, displayed);
  assert.ok(down.some(m => m.method === 'warning'));
});

test('cached canonical translation is restored from disk in paginated history without another API call', async t => {
  const { bridge, down, directory, config } = await setup(t);
  await bridge.fromServer(start()); await bridge.fromServer(finish('Hello'));
  const output = [];
  const store = new Store(directory);
  const second = new Bridge({ config, store, translator: { translate() { throw new Error('Must not retranslate history'); } }, sendUp() {}, sendDown: m => output.push(m) });
  t.after(() => second.close());
  await second.fromClient({ id: 3, method: 'thread/items/list', params: { threadId: 'thread' } });
  await second.fromServer({ id: 3, result: { data: [{ turnId: 'turn', item: { type: 'agentMessage', id: 'item', text: 'Hello' } }], nextCursor: null } });
  assert.equal(output[0].result.data[0].item.text, '你好');
  assert.equal(down.at(-1).params.item.text, output[0].result.data[0].item.text);
});

test('plans also use the authoritative item and consistent canonical translation', async t => {
  const { bridge, down } = await setup(t);
  await bridge.fromServer(start('', 'plan')); await bridge.fromServer(delta('provisional plan', 'plan'));
  await bridge.fromServer(finish('Hello', 'plan'));
  assert.equal(down.filter(m => m.method === 'item/plan/delta').map(m => m.params.delta).join(''), '你好');
  assert.equal(down.at(-1).params.item.text, '你好');
});

test('an unwritable disk cache cannot change the visible translation in final snapshots', async t => {
  const { bridge, store, directory, down } = await setup(t);
  const file = join(directory, 'not-a-directory');
  await writeFile(file, 'occupied');
  store.root = file;
  await bridge.fromServer(start());
  await bridge.fromServer(finish('Hello'));
  await bridge.fromServer(done('Hello'));
  const displayed = down.filter(m => m.method.endsWith('/delta')).map(m => m.params.delta).join('');
  assert.equal(displayed, '你好');
  assert.equal(down.find(m => m.method === 'item/completed').params.item.text, displayed);
  assert.equal(down.find(m => m.method === 'turn/completed').params.turn.items[0].text, displayed);
  assert.ok(down.some(m => m.method === 'warning' && m.params.message.includes('写入失败')));
});

test('history cache read errors preserve original history instead of terminating the connection', async t => {
  const { bridge, store, directory, down } = await setup(t);
  const file = join(directory, 'invalid-cache-root');
  await writeFile(file, 'occupied');
  store.root = file;
  await bridge.fromClient({ id: 9, method: 'thread/read', params: { threadId: 'thread' } });
  const response = { id: 9, result: { thread: { id: 'thread', turns: [{ id: 'turn', items: [{ type: 'agentMessage', id: 'older', text: 'Hello' }] }] } } };
  await bridge.fromServer(response);
  assert.deepEqual(down.at(-1), response);
  assert.ok(down.some(m => m.method === 'warning'));
});

test('cancellation after a committed prefix preserves that prefix and the complete original tail', async t => {
  const entered = deferred(); let calls = 0;
  const api = { async translate(records, _dir, { signal }) {
    if (++calls === 1) return records.map(r => r.masked.replace('Hello', '你好'));
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } };
  const { bridge, down } = await setup(t, api, { batchChars: 1 });
  await bridge.fromServer(start());
  bridge.fromServer(finish('Hello\nWorld\nKeep this tail.'));
  await entered.promise;
  await bridge.fromClient({ id: 2, method: 'turn/interrupt', params: { threadId: 'thread', turnId: 'turn' } });
  await bridge.idle();
  await bridge.fromServer(done('Hello\nWorld\nKeep this tail.', 'interrupted'));
  const displayed = down.filter(m => m.method.endsWith('/delta')).map(m => m.params.delta).join('');
  assert.equal(displayed, '你好\nWorld\nKeep this tail.');
  assert.equal(down.find(m => m.method === 'item/completed').params.item.text, displayed);
  assert.equal(down.find(m => m.method === 'turn/completed').params.turn.items[0].text, displayed);
});
