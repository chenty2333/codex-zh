import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { Bridge } from '../src/bridge.mjs';
import { Translator } from '../src/translator.mjs';

assert.equal(typeof global.gc, 'function', 'Run through npm run test:memory');
const config = { batchChars: 1800, maxTextChars: 128 * 1024, maxBufferedChars: 4 * 1024 * 1024, maxLiveItems: 256 };
let submitted, completed = 0;
const api = { async translate(records, direction) {
  return records.map(r => direction === 'en' ? r.masked.replaceAll('你好', 'Hello') : r.masked.replaceAll('Hello', '你好'));
} };
const bridge = new Bridge({
  config, translator: new Translator(api, config),
  sendUp: message => { submitted = message; },
  sendDown: message => { if (message.method === 'turn/completed') completed++; },
});
const samples = [];
try {
  // Unique prompts/replies prevent a repeated-text fixture from hiding a cache.
  for (let i = 1; i <= 20000; i++) {
    const threadId = 'memory-test', turnId = `turn-${i}`, id = `item-${i}`;
    await bridge.fromClient({ id: i, method: 'turn/start', params: { threadId, input: [{ type: 'text', text: `你好 ${i}` }] } });
    await bridge.fromServer({ id: i, result: { turn: { id: turnId, items: [] } } });
    const user = { type: 'userMessage', id: `user-${i}`, clientId: submitted.params.clientUserMessageId, content: submitted.params.input };
    const item = { type: 'agentMessage', id, text: `Hello ${i}` };
    await bridge.fromServer({ method: 'item/completed', params: { threadId, turnId, item: user } });
    await bridge.fromServer({ method: 'item/started', params: { threadId, turnId, item: { ...item, text: '' } } });
    await bridge.fromServer({ method: 'item/agentMessage/delta', params: { threadId, turnId, itemId: id, delta: item.text } });
    await bridge.fromServer({ method: 'item/completed', params: { threadId, turnId, item } });
    await bridge.fromServer({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed', items: [user, item] } } });
    await bridge.idle();
    assert.equal(bridge.retainedChars, 0); assert.equal(bridge.retainedItems, 0);
    for (const map of [bridge.inputs, bridge.inputRequests, bridge.states, bridge.inputQueues, bridge.outputQueues, bridge.controllers, bridge.tasks]) assert.equal(map.size, 0);
    if (i % 4000 === 0) {
      global.gc();
      const { heapUsed, rss } = process.memoryUsage();
      samples.push({ completedTurns: i, heapUsed, rss, retainedTranslationChars: bridge.retainedChars });
    }
  }
  assert.equal(completed, 20000);
  const heapGrowth = samples.at(-1).heapUsed - samples[0].heapUsed;
  assert.ok(heapGrowth < 8 * 1024 * 1024, 'Retained heap grew unexpectedly after warmup');
  const directory = new URL('../.test-state/memory/', import.meta.url);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(new URL('report.json', directory), JSON.stringify({ checkedAt: new Date().toISOString(), completedTurns: completed, heapGrowthAfterWarmup: heapGrowth, samples }, null, 2), { mode: 0o600 });
  console.log(`20,000 unique turns passed; retained translation text: 0; heap growth after warmup: ${Math.round(heapGrowth / 1024)} KiB.`);
} finally { bridge.close(); }
