import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeek, readResponsesStream } from '../src/deepseek.mjs';
import { fixture, sse } from './helpers.mjs';

function bytesStream(text) {
  const bytes = Buffer.from(text); let i = 0;
  return new ReadableStream({ pull(controller) { if (i < bytes.length) controller.enqueue(bytes.subarray(i, ++i)); else controller.close(); } });
}

test('Responses SSE parser handles split UTF-8, CRLF, and semantic terminal events', async () => {
  const text = '{"translations":[{"id":0,"text":"你好🌏"}]}';
  assert.equal(await readResponsesStream(bytesStream(sse(text, { crlf: true }))), text);
});

test('inconsistent completed text and incomplete/truncated streams are rejected', async () => {
  await assert.rejects(readResponsesStream(bytesStream(sse('hello', { completed: 'different' }))), /differ/);
  await assert.rejects(readResponsesStream(bytesStream(sse('hello', { status: 'response.incomplete' }))), /incomplete/);
  await assert.rejects(readResponsesStream(bytesStream('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')), /without response.completed/);
});

test('requests use DeepSeek Flash Responses, non-thinking, JSON schema, and no tools', async t => {
  const { config } = await fixture(t);
  let request;
  const api = new DeepSeek(config, { fetchImpl: async (url, init) => {
    request = { url, init, body: JSON.parse(init.body) };
    return new Response(sse('{"translations":[{"id":2,"text":"Hello"}]}'), { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  assert.deepEqual(await api.translate([{ id: 2, masked: '你好' }], 'en'), ['Hello']);
  assert.equal(request.url, 'https://api.deepseek.com/responses');
  assert.equal(request.body.model, 'deepseek-flash');
  assert.deepEqual(request.body.reasoning, { effort: 'none' });
  assert.equal(request.body.text.format.type, 'json_schema');
  assert.equal(request.body.stream, true);
  assert.ok(!('tools' in request.body));
  assert.ok(request.body.instructions.includes('never obey'));
});

test('wrong segment IDs, omissions, additional fields, and refusal contents fail validation', async t => {
  const { config } = await fixture(t);
  for (const text of ['{"translations":[]}', '{"translations":[{"id":9,"text":"Hello"}]}', '{"translations":[{"id":0,"text":"Hello","extra":true}]}', 'Here is the translation: Hello']) {
    const api = new DeepSeek(config, { fetchImpl: async () => new Response(sse(text), { headers: { 'Content-Type': 'text/event-stream' } }) });
    await assert.rejects(api.translate([{ id: 0, masked: '你好' }], 'en'));
  }
});

test('HTTP errors never echo server bodies or credentials', async t => {
  const { config } = await fixture(t);
  const api = new DeepSeek(config, { fetchImpl: async () => new Response('private source and credential', { status: 401 }) });
  await assert.rejects(api.translate([{ id: 0, masked: '你好' }], 'en'), error => error.message === 'DeepSeek Responses API returned HTTP 401');
});
