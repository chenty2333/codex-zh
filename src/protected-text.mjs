import { createHash } from 'node:crypto';

export class IntegrityError extends Error {
  constructor(message) { super(message); this.name = 'IntegrityError'; }
}

const HAN = /\p{Script=Han}/u;
export const needsTranslation = (text, direction) => direction === 'en' ? HAN.test(text) : /[A-Za-z]{2}/.test(text);

function fromByteRange(text, range) {
  const bytes = Buffer.from(text);
  if (!range || !Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 || range.end <= range.start || range.end > bytes.length) {
    throw new IntegrityError('Invalid text element byte range');
  }
  const prefix = bytes.subarray(0, range.start).toString('utf8');
  const content = bytes.subarray(range.start, range.end).toString('utf8');
  if (Buffer.byteLength(prefix) !== range.start || Buffer.byteLength(content) !== range.end - range.start || !bytes.subarray(0, range.start).equals(Buffer.from(prefix)) || !bytes.subarray(range.start, range.end).equals(Buffer.from(content))) {
    throw new IntegrityError('Text element range splits a UTF-8 character');
  }
  return { start: prefix.length, end: prefix.length + content.length };
}

function spansFor(text, elements) {
  const spans = [];
  const add = (start, end, structural = false) => { if (end > start) spans.push({ start, end, structural }); };
  const matchAll = (regex, structural = false) => { for (const m of text.matchAll(regex)) add(m.index, m.index + m[0].length, structural); };
  // Whole JSON documents and unified diffs are machine data, not translation input.
  try { const value = JSON.parse(text); if (value && typeof value === 'object') add(0, text.length); } catch { /* prose */ }
  if (/^(?:diff --git |--- a\/|@@ -\d)/m.test(text)) add(0, text.length);
  let fence = null;
  let offset = 0;
  for (const line of text.match(/[^\r\n]*(?:\r\n|\n|\r|$)/g) || []) {
    if (!line) continue;
    const body = line.replace(/[\r\n]+$/, '');
    const open = /^ {0,3}(`{3,}|~{3,})/.exec(body);
    if (!fence && open) fence = { start: offset, char: open[1][0], length: open[1].length };
    else if (fence && new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(body)) {
      add(fence.start, offset + line.length); fence = null;
    } else if (!fence && /^(?: {4}|\t)/.test(body)) add(offset, offset + body.length);
    // Preserve explicit command lines, reference definitions, and table separators.
    if (!fence && /^(?:\s*\$\s+\S|\s*>?\s*(?:git|npm|pnpm|yarn|cargo|python3?|node|curl|sudo|rm|cd|codex)\s+[-\w./]| {0,3}\[[^\]]+\]:\s|\s*\|?[ :|-]+\|[ :|-]*$)/.test(body)) add(offset, offset + body.length);
    offset += line.length;
  }
  if (fence) add(fence.start, text.length);
  matchAll(/(`+)[^\r\n]*?\1/g); // Inline code, including literal Chinese strings.
  matchAll(/`+/g); // An unmatched delimiter is still a literal, never an instruction to repair Markdown.
  matchAll(/<!--[^]*?-->|<\/?[A-Za-z][^>\r\n]*>/g);
  matchAll(/[^]*?/g); // Codex citations and file/visualization markers.
  matchAll(/“[^”\r\n]*”|‘[^’\r\n]*’|「[^」\r\n]*」|『[^』\r\n]*』|"(?:\\.|[^"\\\r\n])*"|(?<![\p{L}\p{N}])'(?:\\.|[^'\\\r\n])*'(?![\p{L}\p{N}])/gu);
  matchAll(/(?:https?:\/\/|file:\/\/|codex:\/\/)[^\s<>"'，。；！？）)\]]+/g);
  matchAll(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  // Paths, filenames, API names, env vars, skills, options, numbers, and identifiers.
  matchAll(/(?:[A-Za-z]:\\|~\/|\.\.?\/|\/)[\p{L}\p{N}_.@+~\-/\\:]+/gu);
  matchAll(/\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+(?:[:#]\d+)?\b/g);
  matchAll(/(?:\$|@)[A-Za-z_][A-Za-z0-9_./:-]*|--[A-Za-z][A-Za-z0-9_-]*(?:=[^\s，。；]+)?/g);
  matchAll(/\b(?:[A-Z][A-Z0-9_]+|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+|[a-z]+(?:[A-Z][a-zA-Z0-9]*)+|[A-Za-z][A-Za-z0-9]*(?=\())\b/g);
  matchAll(/\b[A-Za-z0-9]+(?:-[A-Za-z0-9]+)+\b/g);
  matchAll(/[+-]?\d+(?:[.,:/-]\d+)*(?:%|[a-zA-Z]+)?/g);
  // Link destinations may contain nested or escaped parentheses.
  for (const match of text.matchAll(/\]\(/g)) {
    let depth = 1, end = match.index + 2, quote = null;
    for (; end < text.length && !/[\r\n]/.test(text[end]); end++) {
      const char = text[end];
      if (char === '\\') { end++; continue; }
      if (quote) { if (char === quote) quote = null; continue; }
      if (char === '"' || char === "'") { quote = char; continue; }
      if (char === '(') depth++;
      if (char === ')' && --depth === 0) { end++; break; }
    }
    add(match.index, depth === 0 ? end : match.index + 2, true);
  }
  matchAll(/!\[|\]\[[^\r\n\]]*\]|\*+|_+|\[|\]|\|/g, true);
  // Keep Markdown layout markers, indentation, and line endings byte-for-byte.
  matchAll(/^[ \t]*(?:(?:#{1,6}|>|[-+*]|\d+[.)])[ \t]+)+/gm, true);
  matchAll(/^[ \t]+|[ \t]+$|\r\n|\n|\r/gm, true);
  const ranges = elements.map(e => fromByteRange(text, e.byteRange));
  for (const r of ranges) add(r.start, r.end);
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged = [];
  for (const r of spans) {
    const previous = merged.at(-1);
    if (previous && r.start <= previous.end) {
      previous.end = Math.max(previous.end, r.end);
      previous.structural ||= r.structural;
    }
    else merged.push({ ...r });
  }
  return { spans: merged, ranges };
}

// The API sees opaque markers, never the protected values. Reinsertion is local.
export function protect(text, direction, elements = []) {
  const { spans, ranges } = spansFor(text, elements);
  let nonce = createHash('sha256').update(text).digest('hex').slice(0, 12);
  while (text.includes(`__CZX_${nonce}_`)) nonce += 'x';
  const parts = [];
  let cursor = 0;
  for (const [i, span] of spans.entries()) {
    if (span.start > cursor) parts.push({ text: text.slice(cursor, span.start), protected: false });
    const literal = text.slice(span.start, span.end);
    const structural = span.structural || /^[\s#>*+_.!\[\]|()-]+$/.test(literal);
    parts.push({ text: literal, protected: true, structural, marker: `__CZX_${nonce}_${structural ? 'S' : 'L'}${i}__`, start: span.start, end: span.end });
    cursor = span.end;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), protected: false });
  const records = [];
  let current = [];
  const flush = () => {
    if (!current.length) return;
    const source = current.map(p => p.text).join('');
    const natural = current.filter(p => !p.protected).map(p => p.text).join('');
    records.push({ id: records.length, parts: current, source, translatable: needsTranslation(natural, direction), masked: current.map(p => p.marker || p.text).join('') });
    current = [];
  };
  for (const part of parts) {
    // A protected multiline block can be forwarded as a unit. Translation records have no raw newline.
    if (part.protected && /[\r\n]/.test(part.text)) {
      flush(); records.push({ id: records.length, parts: [part], source: part.text, translatable: false, masked: part.marker });
    } else current.push(part);
  }
  flush();
  return { text, direction, elements, ranges, records };
}

export function restoreRecord(record, translated) {
  if (typeof translated !== 'string' || !translated.trim()) throw new IntegrityError('Empty or non-text translation');
  if (/[\r\n]/.test(translated)) throw new IntegrityError('Translation changed line structure');
  const expected = record.parts.filter(p => p.marker).map(p => p.marker);
  const actual = translated.match(/__CZX_[A-Za-z0-9]+_[SL]\d+__/g) || [];
  if (JSON.stringify([...actual].sort()) !== JSON.stringify([...expected].sort())) throw new IntegrityError('Translation changed protected markers');
  const structural = record.parts.filter(p => p.marker && p.structural).map(p => p.marker);
  if (JSON.stringify(actual.filter(m => structural.includes(m))) !== JSON.stringify(structural)) throw new IntegrityError('Translation reordered Markdown structure');
  const first = record.parts[0], last = record.parts.at(-1);
  if (first?.structural && !translated.startsWith(first.marker)) throw new IntegrityError('Translation moved leading structure');
  if (last?.structural && !translated.endsWith(last.marker)) throw new IntegrityError('Translation moved trailing structure');
  // New machine syntax, identifiers, numeric literals, or formatting must not be invented.
  const natural = actual.reduce((s, marker) => s.replace(marker, ''), translated);
  if (/[`\r\n\[\]|*_]|||__CZX_|\d|https?:\/\/|<\/?[A-Za-z]|^[ \t]*(?:#{1,6}|>|[-+*])[ \t]+/.test(natural)) throw new IntegrityError('Translation introduced protected syntax');
  const restoredParts = [];
  let cursor = 0;
  const byMarker = new Map(record.parts.filter(p => p.marker).map(p => [p.marker, p]));
  for (const marker of actual) {
    const part = byMarker.get(marker);
    const index = translated.indexOf(part.marker, cursor);
    restoredParts.push({ text: translated.slice(cursor, index), protected: false });
    restoredParts.push(part);
    cursor = index + part.marker.length;
  }
  restoredParts.push({ text: translated.slice(cursor), protected: false });
  return { text: restoredParts.map(p => p.text).join(''), parts: restoredParts };
}

export function assemble(plan, restoredRecords) {
  const parts = restoredRecords.flatMap(r => r.parts);
  const text = parts.map(p => p.text).join('');
  const located = [];
  let bytes = 0;
  for (const part of parts) {
    if (part.protected) located.push({ ...part, byteStart: bytes });
    bytes += Buffer.byteLength(part.text);
  }
  const textElements = plan.elements.map((element, i) => {
    const range = plan.ranges[i];
    const owner = located.find(p => p.start <= range.start && p.end >= range.end);
    if (!owner) throw new IntegrityError('A protected text element was lost');
    const start = owner.byteStart + Buffer.byteLength(plan.text.slice(owner.start, range.start));
    const end = start + Buffer.byteLength(plan.text.slice(range.start, range.end));
    return { ...element, byteRange: { start, end } };
  });
  return { text, textElements };
}
