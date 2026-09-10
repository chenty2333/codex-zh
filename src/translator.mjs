import { protect, restoreRecord, assemble } from './protected-text.mjs';
import { digest } from './store.mjs';
import { TRANSLATION_VERSION } from './deepseek.mjs';

const originalRecord = record => ({ text: record.source, parts: record.parts });

export class Translator {
  constructor(api, store, config) { this.api = api; this.store = store; this.config = config; }

  async translate(text, direction, { elements = [], signal, onChunk = () => {}, onFallback = () => {}, fallback = false } = {}) {
    if (this.config.passthrough) { await onChunk(text); return { text, textElements: elements, fallback: false }; }
    const plan = protect(text, direction, elements);
    const restored = [];
    let didFallback = false;
    for (let i = 0; i < plan.records.length;) {
      const first = plan.records[i];
      if (!first.translatable || signal?.aborted) {
        if (signal?.aborted && !fallback) signal.throwIfAborted();
        if (signal?.aborted) didFallback = true;
        const value = originalRecord(first); restored.push(value); await onChunk(value.text, { sourceLength: first.source.length }); i++; continue;
      }
      // A batch is an immutable commit unit: validate every record before emitting any of it.
      const batch = [];
      let size = 0;
      while (i < plan.records.length && size < this.config.batchChars) {
        const record = plan.records[i++]; batch.push(record); size += record.masked.length;
      }
      const translatable = batch.filter(r => r.translatable);
      const key = digest({ v: TRANSLATION_VERSION, model: this.config.model, endpoint: this.config.baseURL, direction, records: translatable.map(r => ({ id: r.id, text: r.masked })) });
      let replacements;
      try {
        signal?.throwIfAborted();
        let values;
        try { values = await this.store.get('batches', key); } catch { /* Optional cache. */ }
        if (!Array.isArray(values) || values.length !== translatable.length) values = await this.api.translate(translatable, direction, { signal });
        replacements = new Map(translatable.map((r, index) => [r.id, restoreRecord(r, values[index])]));
        try { await this.store.set('batches', key, values); } catch { /* Optional cache. */ }
        signal?.throwIfAborted();
      } catch (error) {
        if (!fallback) throw error;
        didFallback = true;
        await onFallback(error);
        replacements = new Map();
      }
      const committed = batch.map(r => replacements.get(r.id) || originalRecord(r));
      restored.push(...committed);
      await onChunk(committed.map(r => r.text).join(''), { sourceLength: batch.reduce((n, r) => n + r.source.length, 0) });
    }
    return { ...assemble(plan, restored), fallback: didFallback };
  }
}
