import { protect, restoreRecord, assemble, IntegrityError } from './protected-text.mjs';

const originalRecord = record => ({ text: record.source, parts: record.parts });

export class Translator {
  constructor(api, config) { this.api = api; this.config = config; }

  async translate(text, direction, { elements = [], signal, onChunk = () => {}, onFallback = () => {}, fallback = false, maxOutputChars = 3 * (this.config.maxTextChars ?? 128 * 1024) } = {}) {
    if (this.config.passthrough) { await onChunk(text); return { text, textElements: elements, fallback: false }; }
    if (text.length > maxOutputChars) throw new IntegrityError('Translation exceeds the text buffer limit');
    const plan = protect(text, direction, elements);
    const restored = [];
    let didFallback = false, committedChars = 0, consumedChars = 0;
    for (let i = 0; i < plan.records.length;) {
      const first = plan.records[i];
      if (!first.translatable || signal?.aborted) {
        if (signal?.aborted && !fallback) signal.throwIfAborted();
        if (signal?.aborted) didFallback = true;
        const value = originalRecord(first); restored.push(value);
        committedChars += value.text.length; consumedChars += first.source.length;
        await onChunk(value.text, { sourceLength: first.source.length }); i++; continue;
      }
      // A batch is an immutable commit unit: validate every record before emitting any of it.
      const batch = [];
      let size = 0;
      while (i < plan.records.length && size < this.config.batchChars) {
        const record = plan.records[i++]; batch.push(record); size += record.masked.length;
      }
      const translatable = batch.filter(r => r.translatable);
      const sourceChars = batch.reduce((n, r) => n + r.source.length, 0);
      let replacements;
      try {
        signal?.throwIfAborted();
        const values = await this.api.translate(translatable, direction, { signal });
        replacements = new Map(translatable.map((r, index) => [r.id, restoreRecord(r, values[index])]));
        const translatedChars = batch.reduce((n, r) => n + (replacements.get(r.id)?.text.length ?? r.source.length), 0);
        // Always leave enough room for the untouched tail if a later batch fails.
        if (committedChars + translatedChars + text.length - consumedChars - sourceChars > maxOutputChars) throw new IntegrityError('Translation expanded beyond its buffer limit');
        signal?.throwIfAborted();
      } catch (error) {
        if (!fallback) throw error;
        didFallback = true;
        await onFallback(error);
        replacements = new Map();
      }
      const committed = batch.map(r => replacements.get(r.id) || originalRecord(r));
      restored.push(...committed);
      const chunk = committed.map(r => r.text).join('');
      committedChars += chunk.length; consumedChars += sourceChars;
      await onChunk(chunk, { sourceLength: sourceChars });
    }
    return { ...assemble(plan, restored), fallback: didFallback };
  }
}
