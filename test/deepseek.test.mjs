import test from 'node:test';
import assert from 'node:assert/strict';
import { DeepSeek, readResponsesStream } from '../src/deepseek.mjs';
import { fixture, sse, completedResponse } from './helpers.mjs';

function bytesStream(text) {
  const bytes = Buffer.from(text); let i = 0;
  return new ReadableStream({ pull(controller) { if (i < bytes.length) controller.enqueue(bytes.subarray(i, ++i)); else controller.close(); } });
}

test('Responses SSE parser handles split UTF-8 and CRLF', async () => {
  const text = '# 你好🌏\n\n完整译文。\n';
  assert.equal(await readResponsesStream(bytesStream(sse(text, { crlf: true }))), text);
});

test('incomplete or disconnected API responses fail the request', async () => {
  await assert.rejects(readResponsesStream(bytesStream(sse('hello', { status: 'response.incomplete' }))), /incomplete/);
  await assert.rejects(readResponsesStream(bytesStream('data: {"type":"response.output_text.delta","delta":"partial"}\n\n')), /without response.completed/);
});

test('requests send whole original text and return the model text directly in both directions', async t => {
  const { config } = await fixture(t);
  const source = '# 标题\n\n请检查 iPhone 17e 的 A19、`src/auth.ts` 和“提交”。\n```js\nconst n = 3;\n```\n' + '完整上下文。'.repeat(400);
  const translated = '  # Returned text\n\nDifferent formatting, "Save", and 42.\n';
  for (const [direction, language] of [['en', 'English'], ['zh', 'Simplified Chinese']]) {
    let request;
    const api = new DeepSeek(config, { fetchImpl: async (url, init) => {
      request = { url, body: JSON.parse(init.body) };
      return new Response(sse('intermediate text', { completed: translated }), { headers: { 'Content-Type': 'text/event-stream' } });
    } });
    assert.equal(await api.translate(source, direction), translated);
    assert.equal(request.url, 'https://api.deepseek.com/responses');
    assert.equal(request.body.model, 'deepseek-flash');
    assert.equal(request.body.input, source);
    assert.ok(request.body.instructions.includes(language));
    assert.ok(request.body.instructions.includes('Output only'));
    assert.deepEqual(request.body.reasoning, { effort: 'none' });
    assert.equal(request.body.stream, true);
    assert.ok(!('tools' in request.body));
    assert.ok(!('text' in request.body));
  }
});

test('JSON API envelopes expose the returned text without parsing it as translation JSON', async t => {
  const { config } = await fixture(t);
  for (const text of ['{"label":"提交"}', 'Here is the translation:\n你好', '']) {
    const api = new DeepSeek(config, { fetchImpl: async () => Response.json(completedResponse(text)) });
    assert.equal(await api.translate('Hello', 'zh'), text);
  }
});

test('HTTP errors never echo server bodies or credentials', async t => {
  const { config } = await fixture(t);
  const api = new DeepSeek(config, { fetchImpl: async () => new Response('private source and credential', { status: 401 }) });
  await assert.rejects(api.translate('你好', 'en'), error => error.message === 'DeepSeek Responses API returned HTTP 401');
});
