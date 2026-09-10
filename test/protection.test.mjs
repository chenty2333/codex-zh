import test from 'node:test';
import assert from 'node:assert/strict';
import { protect, restoreRecord, assemble, IntegrityError } from '../src/protected-text.mjs';

function identity(plan) { return plan.records.map(r => r.translatable ? restoreRecord(r, r.masked) : ({ text: r.source, parts: r.parts })); }

test('round-trip preserves Markdown, CRLF, fenced code, quotes, links, and whitespace byte-for-byte', () => {
  const text = '# 标题\r\n\r\n- 请检查 **登录**，使用 `auth.go`。\r\n```ts\r\nconst label = "提交";\r\n```\r\n[说明](https://example.test/path?q=1) 和“准确字面量”。  \r\n';
  const plan = protect(text, 'en');
  assert.equal(assemble(plan, identity(plan)).text, text);
  const apiInput = plan.records.filter(r => r.translatable).map(r => r.masked).join('\n');
  for (const literal of ['auth.go', 'const label', '准确字面量', 'https://example.test']) assert.ok(!apiInput.includes(literal));
});

test('JSON, diffs, indented code, and unfinished fences are not translated', () => {
  for (const text of ['{"label":"提交","count":3}', 'diff --git a/a b/a\n-旧\n+新\n', '    const text = "hello";\n', '~~~python\nprint("hello")\n']) {
    const plan = protect(text, 'zh');
    assert.ok(plan.records.every(r => !r.translatable));
    assert.equal(assemble(plan, identity(plan)).text, text);
  }
});

test('literal markers can move for grammar while exact values and UTF-8 attachment ranges survive', () => {
  const text = '请修改 @文件.ts 中的 `count = 3`。';
  const start = Buffer.byteLength('请修改 '), end = start + Buffer.byteLength('@文件.ts');
  const plan = protect(text, 'en', [{ byteRange: { start, end }, placeholder: '@文件.ts' }]);
  const r = plan.records[0];
  const markers = r.parts.filter(p => p.marker);
  assert.equal(markers.length, 2);
  const result = assemble(plan, [restoreRecord(r, `Modify ${markers[1].marker} in ${markers[0].marker}.`)]);
  assert.ok(result.text.includes('`count = 3`'));
  const range = result.textElements[0].byteRange;
  assert.equal(Buffer.from(result.text).subarray(range.start, range.end).toString(), '@文件.ts');
  assert.equal(result.textElements[0].placeholder, '@文件.ts');
});

test('missing, duplicated, invented, and modified protected tokens are rejected', () => {
  const r = protect('请修改 `file.ts`，限制为 3 次。', 'en').records[0];
  const marker = r.parts.find(p => p.marker).marker;
  for (const value of [r.masked.replace(marker, ''), `${r.masked}${marker}`, r.masked.replace(marker, `${marker}extra__CZX_dead_L99__`), r.masked.replace(marker, marker.toLowerCase())]) {
    assert.throws(() => restoreRecord(r, value), IntegrityError);
  }
});

test('line breaks, leading Markdown movement, and new code are rejected', () => {
  const r = protect('- 你好 **朋友**', 'en').records[0];
  assert.throws(() => restoreRecord(r, `${r.masked}\nInjected`), IntegrityError);
  assert.throws(() => restoreRecord(r, `Hello ${r.masked}`), IntegrityError);
  assert.throws(() => restoreRecord(r, `${r.masked} \`bad\``), IntegrityError);
});

test('invalid and split Unicode byte ranges fail closed', () => {
  for (const range of [{ start: 1, end: 3 }, { start: -1, end: 3 }, { start: 0, end: 200 }]) {
    assert.throws(() => protect('中文', 'en', [{ byteRange: range }]), IntegrityError);
  }
});

test('URLs, shell commands, numbers, env names, citations, and original inline strings never reach translation service', () => {
  const text = '请保留 `x`、“提交”、TIMEOUT_MS、deepseek-flash、https://example.test/a 和 1.25。\n$ git status --short\n来源 citeref\n';
  const plan = protect(text, 'en');
  const input = plan.records.filter(r => r.translatable).map(r => r.masked).join('');
  for (const value of ['TIMEOUT_MS', 'deepseek-flash', 'example.test', '1.25', 'git status', 'cite', '提交']) assert.ok(!input.includes(value));
  assert.equal(assemble(plan, identity(plan)).text, text);
});

test('apostrophes in English contractions remain prose while quoted strings are protected', () => {
  const text = "I don't think it's safe. Keep 'Save' unchanged.";
  const plan = protect(text, 'zh');
  const input = plan.records.filter(r => r.translatable).map(r => r.masked).join('');
  assert.ok(input.includes("don't think it's safe"));
  assert.ok(!input.includes("'Save'"));
  assert.equal(assemble(plan, identity(plan)).text, text);
});

test('numbered list prefixes and link destinations retain their structural position', () => {
  const list = protect('1. 请修改文件。', 'en').records[0];
  assert.ok(list.parts[0].structural);
  assert.throws(() => restoreRecord(list, `Modify ${list.masked}`), IntegrityError);
  const link = protect('See [details](https://example.test/a).', 'zh').records[0];
  const markers = link.parts.filter(p => p.marker);
  assert.ok(markers.every(p => p.structural));
  assert.throws(() => restoreRecord(link, `参见 ${markers[1].marker}详情${markers[0].marker}。`), IntegrityError);
  assert.equal(assemble(protect('See [details](https://example.test/a).', 'zh'), [restoreRecord(link, `参见 ${markers[0].marker}详情${markers[1].marker}。`)]).text, '参见 [详情](https://example.test/a)。');
  const nested = protect('See [details](https://example.test/a_(b) "title").', 'zh');
  assert.equal(assemble(nested, identity(nested)).text, nested.text);
  const destination = nested.records[0].parts.find(p => p.text.startsWith(']('));
  assert.equal(destination.text, '](https://example.test/a_(b) "title")');
  assert.ok(destination.structural);
});

test('a translation cannot add raw Markdown formatting around existing text', () => {
  const record = protect('Hello world', 'zh').records[0];
  for (const text of ['*你好*', '[你好]', '|你好|', '# 你好', '- 你好']) {
    assert.throws(() => restoreRecord(record, text), IntegrityError);
  }
});
