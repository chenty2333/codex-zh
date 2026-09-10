import test from 'node:test';
import assert from 'node:assert/strict';
import { Bridge } from '../src/bridge.mjs';
import { Translator } from '../src/translator.mjs';
import { readdir } from 'node:fs/promises';
import { fixture, fakeAPI, deferred } from './helpers.mjs';

async function setup(t, api = fakeAPI((s, dir) => dir === 'en' ? s.replaceAll('你好', 'Hello') : s.replaceAll('Hello', '你好').replaceAll('World', '世界')), overrides = {}) {
  const f = await fixture(t, overrides), up = [], down = [];
  const translator = new Translator(api, f.config);
  const bridge = new Bridge({ translator, config: f.config, sendUp: m => up.push(structuredClone(m)), sendDown: m => down.push(structuredClone(m)) });
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

test('whole input and raw returned text reach the backend with source annotations kept only in the echo', async t => {
  const source = '请修改 @文件.ts。\n\n```js\nconst label = "提交";\n```\n' + '保留完整上下文。'.repeat(300);
  const translated = '# Translation\n\nEdit the file.\n\n```js\nconst label = "Submit";\n```\nAdded 123.\n';
  const { bridge, up, down, api } = await setup(t, fakeAPI(() => translated));
  const original = prompt();
  original.params.input[0] = { type: 'text', text: source, text_elements: [{ byteRange: { start: Buffer.byteLength('请修改 '), end: Buffer.byteLength('请修改 @文件.ts') }, placeholder: '@文件.ts' }] };
  await bridge.fromClient(original);
  assert.deepEqual(api.calls, [{ text: source, direction: 'en' }]);
  assert.equal(up[0].params.input[0].text, translated);
  assert.deepEqual(up[0].params.input[0].text_elements, []);
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
  assert.deepEqual(down.at(-1).params.item.content[0], original.params.input[0]);
  assert.deepEqual(down.at(-1).params.item.content.slice(1), normalized.slice(1));
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
  assert.deepEqual(api.calls, [{ text: 'Hello\nWorld', direction: 'zh' }]);
});

test('approvals, tool output, and interrupt bypass a slow translation; remainder is preserved', async t => {
  const entered = deferred();
  const api = { async translate(_text, _direction, { signal }) {
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

test('fallback warnings identify the failure without leaking response text or credentials', async t => {
  const privateText = 'private response body and Bearer test-credential';
  const cases = [
    [new Error('DeepSeek Responses API returned HTTP 429'), '翻译接口返回 HTTP 429'],
    [new Error('DeepSeek translation timed out'), '翻译请求超时'],
    [new TypeError('fetch failed', { cause: new Error(privateText) }), '翻译网络请求失败'],
    [new SyntaxError(privateText), '未识别的翻译错误'],
    [new Error(`DeepSeek Responses API returned HTTP 500\n${privateText}`), '未识别的翻译错误'],
  ];
  for (const [error, reason] of cases) {
    const api = { async translate() { throw error; } };
    const { bridge, down } = await setup(t, api);
    await bridge.fromServer(start()); await bridge.fromServer(finish('Hello'));
    const warnings = down.filter(m => m.method === 'warning');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].params.message, `回复翻译失败（${reason}）；本条回复保留原文。`);
    assert.equal(down.filter(m => m.method.endsWith('/delta')).map(m => m.params.delta).join(''), 'Hello');
    assert.equal(down.at(-1).params.item.text, 'Hello');
    assert.ok(!JSON.stringify(down).includes(privateText));
  }
});

test('resume, fork, and all history reads retain original text without translation or disk writes', async t => {
  const { bridge, down, directory, api } = await setup(t);
  await bridge.fromServer(start()); await bridge.fromServer(finish('Hello'));
  const item = { type: 'agentMessage', id: 'item', text: 'Hello' };
  const turn = { id: 'turn', items: [item] }, thread = { id: 'thread', turns: [turn] };
  const histories = [
    ['thread/resume', { thread }], ['thread/fork', { thread }], ['thread/read', { thread }],
    ['thread/list', { data: [thread] }], ['thread/turns/list', { data: [turn] }],
    ['thread/items/list', { data: [{ turnId: 'turn', item }], nextCursor: null }],
  ];
  for (const [method, result] of histories) {
    await bridge.fromClient({ id: 3, method, params: { threadId: 'thread' } });
    const message = { id: 3, result };
    await bridge.fromServer(message);
    assert.deepEqual(down.at(-1), message);
  }
  assert.equal(api.calls.length, 1);
  assert.deepEqual(await readdir(directory), []);
});

test('plans also use the authoritative item and consistent canonical translation', async t => {
  const { bridge, down } = await setup(t);
  await bridge.fromServer(start('', 'plan')); await bridge.fromServer(delta('provisional plan', 'plan'));
  await bridge.fromServer(finish('Hello', 'plan'));
  assert.equal(down.filter(m => m.method === 'item/plan/delta').map(m => m.params.delta).join(''), '你好');
  assert.equal(down.at(-1).params.item.text, '你好');
});

test('current-turn final snapshots reuse the visible translation and immediately release retained text', async t => {
  const { bridge, directory, down } = await setup(t);
  await bridge.fromServer(start());
  await bridge.fromServer(finish('Hello'));
  assert.equal(bridge.retainedChars, '你好'.length);
  await bridge.fromServer(done('Hello'));
  await bridge.idle();
  const displayed = down.filter(m => m.method.endsWith('/delta')).map(m => m.params.delta).join('');
  assert.equal(displayed, '你好');
  assert.equal(down.find(m => m.method === 'item/completed').params.item.text, displayed);
  assert.equal(down.find(m => m.method === 'turn/completed').params.turn.items[0].text, displayed);
  assert.equal(bridge.retainedChars, 0); assert.equal(bridge.retainedItems, 0);
  assert.equal(bridge.states.size, 0); assert.equal(bridge.tasks.size, 0);
  assert.equal(bridge.outputQueues.size, 0);
  assert.deepEqual(await readdir(directory), []);
});

test('input text exists only through its live echo and final turn snapshot', async t => {
  const { bridge, up, down } = await setup(t);
  const original = prompt(); await bridge.fromClient(original);
  const user = { type: 'userMessage', id: 'user', clientId: up[0].params.clientUserMessageId, content: up[0].params.input };
  await bridge.fromServer({ id: 1, result: { turn: { id: 'turn', items: [user] } } });
  assert.deepEqual(down.at(-1).result.turn.items[0].content, original.params.input);
  await bridge.fromServer({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [user] } } });
  await bridge.idle();
  assert.deepEqual(down.at(-1).params.turn.items[0].content, original.params.input);
  assert.equal(bridge.inputs.size, 0); assert.equal(bridge.inputRequests.size, 0);
  assert.equal(bridge.retainedChars, 0); assert.equal(bridge.retainedItems, 0);
  const response = { id: 9, result: { thread: { id: 'thread', turns: [{ id: 'turn', items: [user] }] } } };
  await bridge.fromServer(response);
  assert.equal(down.at(-1).result.thread.turns[0].items[0].content[0].text, 'Hello `file.ts`');
});

test('one thousand completed turns retain no history, pending inputs, controllers, or queue entries', async t => {
  let calls = 0;
  const api = { async translate(text, dir) {
    calls++;
    return dir === 'en' ? text.replaceAll('你好', 'Hello') : text.replaceAll('Hello', '你好');
  } };
  const { bridge, up, down, directory } = await setup(t, api);
  for (let i = 0; i < 1000; i++) {
    up.length = 0; down.length = 0;
    await bridge.fromClient(prompt());
    await bridge.fromServer({ id: 1, result: { turn: { id: 'turn', items: [] } } });
    await bridge.fromServer(start());
    await bridge.fromServer(delta('Hello'));
    await bridge.fromServer(finish('Hello'));
    await bridge.fromServer(done('Hello'));
    await bridge.idle();
    assert.equal(down.at(-1).params.turn.items[0].text, '你好');
    for (const collection of [bridge.states, bridge.inputs, bridge.inputRequests, bridge.controllers, bridge.inputQueues, bridge.outputQueues, bridge.tasks]) assert.equal(collection.size, 0);
    assert.equal(bridge.retainedChars, 0); assert.equal(bridge.retainedItems, 0);
  }
  assert.equal(calls, 2000, 'identical text must be translated afresh on each new turn');
  assert.deepEqual(await readdir(directory), []);
});

test('one long turn has bounded retained items and forwards additional replies in original form', async t => {
  const { bridge, down, api } = await setup(t, undefined, { maxLiveItems: 4, maxTextChars: 128, maxBufferedChars: 2048 });
  for (let i = 0; i < 1000; i++) {
    down.length = 0;
    const id = `item-${i}`;
    const begin = start(), piece = delta('Hello'), end = finish('Hello');
    begin.params.item.id = id; piece.params.itemId = id; end.params.item.id = id;
    await bridge.fromServer(begin); await bridge.fromServer(piece); await bridge.fromServer(end);
    assert.ok(bridge.retainedItems <= 4);
    assert.ok(bridge.retainedChars <= 2048);
    assert.equal(down.at(-1).params.item.text, i < 4 ? '你好' : 'Hello');
  }
  assert.equal(api.calls.length, 4);
  assert.equal(bridge.states.size, 4);
  await bridge.fromServer({ method: 'turn/completed', params: { threadId: 'thread', turn: { id: 'turn', status: 'completed', items: [] } } });
  await bridge.idle();
  assert.equal(bridge.retainedItems, 0); assert.equal(bridge.retainedChars, 0);
});

test('oversized source deltas switch to native text without retaining or losing the original prefix', async t => {
  const { bridge, down, api } = await setup(t, undefined, { maxTextChars: 8, maxBufferedChars: 32 });
  await bridge.fromServer(start()); await bridge.fromServer(delta('Hello')); await bridge.fromServer(delta('World'));
  assert.equal(bridge.retainedChars, 0);
  await bridge.fromServer(finish('HelloWorld'));
  assert.equal(down.filter(m => m.method.endsWith('/delta')).map(m => m.params.delta).join(''), 'HelloWorld');
  assert.equal(down.at(-1).params.item.text, 'HelloWorld');
  assert.equal(api.calls.length, 0); assert.equal(bridge.states.size, 0);
  assert.equal(bridge.retainedItems, 0);
});

test('an oversized authoritative item is displayed whole without invoking translation', async t => {
  const { bridge, down, api } = await setup(t, undefined, { maxTextChars: 8, maxBufferedChars: 32 });
  await bridge.fromServer(start()); await bridge.fromServer(delta('short'));
  await bridge.fromServer(finish('Hello World'));
  assert.equal(down.filter(m => m.method.endsWith('/delta')).map(m => m.params.delta).join(''), 'Hello World');
  assert.equal(down.at(-1).params.item.text, 'Hello World');
  assert.equal(api.calls.length, 0); assert.equal(bridge.retainedItems, 0);
});

test('large returned translations are displayed intact and accounted for until the turn ends', async t => {
  const translated = '译文'.repeat(100);
  const { bridge, down } = await setup(t, fakeAPI(() => translated), { maxTextChars: 16, maxBufferedChars: 64 });
  await bridge.fromServer(start()); await bridge.fromServer(finish('Hello'));
  assert.equal(down.find(m => m.method === 'item/agentMessage/delta').params.delta, translated);
  assert.equal(down.at(-1).params.item.text, translated);
  assert.equal(bridge.retainedChars, translated.length);
  assert.ok(!down.some(m => m.method === 'warning'));
  await bridge.fromServer(done('Hello'));
  assert.equal(bridge.retainedChars, 0);
});

test('too many pending prompts fail closed and closing the connection releases aborted work', async t => {
  const entered = deferred();
  const api = { async translate(_r, _d, { signal }) {
    entered.resolve();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true }));
  } };
  const { bridge, down, up } = await setup(t, api, { maxTextChars: 128, maxBufferedChars: 512, maxLiveItems: 1 });
  const first = bridge.fromClient(prompt()); await entered.promise;
  const second = prompt(); second.id = 2;
  await bridge.fromClient(second);
  assert.equal(down.at(-1).id, 2); assert.equal(down.at(-1).error.code, -32001);
  assert.equal(up.length, 0); assert.equal(bridge.retainedItems, 1);
  bridge.close(); await first; await bridge.idle();
  assert.equal(bridge.retainedItems, 0); assert.equal(bridge.retainedChars, 0);
  assert.equal(bridge.inputs.size, 0); assert.equal(bridge.controllers.size, 0);
});

test('unsubscribe releases unfinished turn text and input echo records', async t => {
  const { bridge } = await setup(t);
  await bridge.fromClient(prompt());
  await bridge.fromServer(start()); await bridge.fromServer(finish('Hello'));
  assert.ok(bridge.retainedItems > 0);
  await bridge.fromClient({ id: 2, method: 'thread/unsubscribe', params: { threadId: 'thread' } });
  assert.equal(bridge.retainedChars, 0); assert.equal(bridge.retainedItems, 0);
  assert.equal(bridge.states.size, 0); assert.equal(bridge.inputs.size, 0); assert.equal(bridge.inputRequests.size, 0);
});
