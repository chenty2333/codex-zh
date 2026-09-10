import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { Store } from '../src/store.mjs';

export async function fixture(t, overrides = {}) {
  const base = resolve('.test-state'); await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, 'unit-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = { model: 'deepseek-flash', baseURL: 'https://api.deepseek.com', apiKey: 'test-credential', timeoutMs: 3000, batchChars: 1800, passthrough: false, stateDir: directory, ...overrides };
  return { directory, config, store: new Store(directory) };
}

export const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};

export function fakeAPI(transform = s => s.replaceAll('Hello', '你好').replaceAll('World', '世界').replaceAll('你好', 'Hello')) {
  const calls = [];
  return { calls, async translate(records, direction, { signal } = {}) {
    signal?.throwIfAborted(); calls.push({ records: structuredClone(records), direction });
    return records.map(r => transform(r.masked, direction));
  } };
}

export function completedResponse(text) {
  return { id: 'response-test', status: 'completed', output: [{ id: 'message-test', type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] }] };
}

export function sse(text, { completed = text, status = 'response.completed', crlf = false } = {}) {
  const events = [
    { type: 'response.created', response: { id: 'response-test', status: 'in_progress' } },
    { type: 'response.output_text.delta', delta: text.slice(0, Math.floor(text.length / 2)) },
    { type: 'response.output_text.delta', delta: text.slice(Math.floor(text.length / 2)) },
    { type: status, response: completedResponse(completed) },
  ];
  const content = events.map((e, i) => `event: ${e.type}\ndata: ${JSON.stringify({ ...e, sequence_number: i })}\n\n`).join('');
  return crlf ? content.replaceAll('\n', '\r\n') : content;
}
