import { randomUUID } from 'node:crypto';
import { digest } from './store.mjs';
import { TRANSLATION_VERSION } from './deepseek.mjs';

const INPUT_METHODS = new Set(['turn/start', 'turn/steer']);
const TEXT_TYPES = new Set(['agentMessage', 'plan']);
const DELTA_METHODS = new Map([['item/agentMessage/delta', 'agentMessage'], ['item/plan/delta', 'plan']]);
const HISTORY_METHODS = new Set(['thread/start', 'thread/resume', 'thread/read', 'thread/fork', 'thread/list', 'thread/turns/list', 'thread/items/list', 'turn/start']);
const clone = value => structuredClone(value);
const inputDigest = input => digest(input.map(part => {
  const normalized = { ...part };
  if (part.type === 'text') normalized.text_elements = (part.text_elements || []).map(element => ({ ...element, placeholder: element.placeholder ?? null }));
  if (['image', 'localImage'].includes(part.type)) normalized.detail = part.detail ?? null;
  return normalized;
}));

// Only known fields are transformed. Tools, approvals, attachments, protocol IDs,
// timestamps, capabilities, and unknown future methods are forwarded unchanged.
export class Bridge {
  constructor({ translator, store, config, sendUp, sendDown, log = () => {} }) {
    Object.assign(this, { translator, store, config, sendUp, sendDown, log });
    this.requests = new Map(); this.inputQueues = new Map(); this.outputQueues = new Map();
    this.states = new Map(); this.controllers = new Set(); this.tasks = new Set(); this.closed = false;
  }

  track(promise) {
    this.tasks.add(promise);
    promise.finally(() => this.tasks.delete(promise)).catch(() => {});
    return promise;
  }
  queue(map, key, task) {
    const previous = map.get(key) || Promise.resolve();
    const next = previous.catch(() => {}).then(() => { if (!this.closed) return task(); });
    map.set(key, next);
    next.finally(() => { if (map.get(key) === next) map.delete(key); }).catch(() => {});
    return this.track(next);
  }
  async idle() { while (this.tasks.size) await Promise.allSettled([...this.tasks]); }
  down(message) { if (!this.closed) this.sendDown(message); }
  controller(threadId) {
    const record = { threadId, controller: new AbortController() };
    this.controllers.add(record); return record;
  }
  interrupt(threadId) {
    for (const state of this.controllers) if (state.threadId === threadId) state.controller.abort(new Error('Translation interrupted'));
    // Mark buffered but not-yet-translated output as interrupted as well.
    for (const state of this.states.values()) if (state.threadId === threadId) state.interrupted = true;
  }
  close() { this.closed = true; for (const state of this.controllers) state.controller.abort(); this.states.clear(); }
  warning(threadId, message) { this.down({ method: 'warning', params: { threadId, message } }); }
  itemKey(item) { return digest({ version: TRANSLATION_VERSION, model: this.config.model, endpoint: this.config.baseURL, id: item.id, type: item.type, source: item.text }); }

  fromClient(message) {
    if (this.closed) return Promise.resolve();
    if (this.config.passthrough) { this.sendUp(message); return Promise.resolve(); }
    if (message.method && message.id !== undefined) this.requests.set(message.id, { method: message.method, params: clone(message.params || {}) });
    if (message.method === 'turn/interrupt' || message.method === 'thread/unsubscribe') {
      this.interrupt(message.params?.threadId);
      this.sendUp(message); return Promise.resolve();
    }
    if (!INPUT_METHODS.has(message.method)) { this.sendUp(message); return Promise.resolve(); }
    const threadId = message.params?.threadId;
    // Create this before queuing so interruption cancels queued submissions too.
    const state = this.controller(threadId);
    return this.queue(this.inputQueues, threadId, async () => {
      try {
        state.controller.signal.throwIfAborted();
        const outgoing = clone(message);
        const original = clone(message.params.input);
        if (!Array.isArray(original)) throw new Error('Invalid user input');
        for (const part of outgoing.params.input) {
          if (part.type !== 'text' || typeof part.text !== 'string') continue;
          const translated = await this.translator.translate(part.text, 'en', { elements: part.text_elements || [], signal: state.controller.signal });
          part.text = translated.text;
          if ('text_elements' in part || translated.textElements.length) part.text_elements = translated.textElements;
        }
        state.controller.signal.throwIfAborted();
        const clientId = outgoing.params.clientUserMessageId || randomUUID();
        outgoing.params.clientUserMessageId = clientId;
        const record = { original, translated: outgoing.params.input };
        await this.store.set('user-clients', [threadId, clientId], record);
        await this.store.set('user-content', [threadId, inputDigest(outgoing.params.input)], record);
        state.controller.signal.throwIfAborted();
        this.sendUp(outgoing);
      } catch (error) {
        this.requests.delete(message.id);
        this.down({ id: message.id, error: { code: -32001, message: state.controller.signal.aborted
          ? '翻译已取消，原始消息未提交。'
          : '翻译失败或完整性校验未通过，原始消息未提交。请重试，或使用 codex-zh --passthrough。' } });
        this.log(`Input translation stopped (${error.name || 'Error'}).`);
      } finally { this.controllers.delete(state); }
    });
  }

  stateFor(params, type = 'agentMessage') {
    const key = `${params.threadId}:${params.turnId}:${params.itemId || params.item?.id}`;
    let state = this.states.get(key);
    if (!state) {
      state = { key, threadId: params.threadId, turnId: params.turnId, itemId: params.itemId || params.item?.id, type, source: '', emitted: '', done: false, interrupted: false };
      this.states.set(key, state);
    }
    return state;
  }

  fromServer(message) {
    if (this.closed) return Promise.resolve();
    if (this.config.passthrough) { this.down(message); return Promise.resolve(); }
    // Server-initiated requests must never wait behind translation: approvals can unblock tools.
    if (message.method && message.id !== undefined) { this.down(message); return Promise.resolve(); }
    if (!message.method && message.id !== undefined) {
      const request = this.requests.get(message.id); this.requests.delete(message.id);
      if (!request || !message.result || !HISTORY_METHODS.has(request.method)) { this.down(message); return Promise.resolve(); }
      const threadId = message.result.thread?.id || request.params.threadId || `request:${message.id}`;
      return this.queue(this.outputQueues, threadId, async () => {
        const outgoing = clone(message);
        await this.restoreHistory(outgoing.result, request);
        this.down(outgoing);
      });
    }
    const params = message.params || {};
    const threadId = params.threadId || params.thread?.id;
    if (DELTA_METHODS.has(message.method)) {
      const state = this.stateFor(params, DELTA_METHODS.get(message.method));
      if (typeof params.delta === 'string') state.source += params.delta;
      // Source deltas are deliberately held until the authoritative item/completed.
      return Promise.resolve();
    }
    if (message.method === 'item/started' && TEXT_TYPES.has(params.item?.type)) {
      this.stateFor(params, params.item.type);
      const outgoing = clone(message); outgoing.params.item.text = '';
      return this.queue(this.outputQueues, threadId, () => this.down(outgoing));
    }
    if (message.method === 'item/completed' && TEXT_TYPES.has(params.item?.type)) {
      const state = this.stateFor(params, params.item.type);
      return this.queue(this.outputQueues, threadId, () => this.completeText(message, state));
    }
    if (message.method === 'turn/completed') {
      // Abort pending API work immediately on cancellation; flush all uncommitted source intact.
      if (params.turn?.status === 'interrupted') this.interrupt(threadId);
      return this.queue(this.outputQueues, threadId, async () => {
        const matching = [...this.states.values()].filter(s => s.threadId === threadId && s.turnId === params.turn?.id);
        for (const state of matching.filter(s => !s.done)) {
          const original = params.turn?.items?.find(i => i.id === state.itemId);
          await this.completeText({ method: 'item/completed', params: { threadId, turnId: state.turnId, item: original || { type: state.type, id: state.itemId, text: state.source } } }, state);
        }
        const outgoing = clone(message);
        if (outgoing.params.turn) await this.restoreTurn(outgoing.params.turn, threadId);
        this.down(outgoing);
        for (const state of matching) this.states.delete(state.key);
      });
    }
    if (message.method === 'thread/closed' || message.method === 'thread/archived') this.interrupt(threadId);
    if (params.item?.type === 'userMessage') return this.queue(this.outputQueues, threadId, async () => {
      const outgoing = clone(message); await this.restoreItem(outgoing.params.item, threadId); this.down(outgoing);
    });
    // Tool progress and control-plane notifications bypass text buffering as well.
    this.down(message); return Promise.resolve();
  }

  async completeText(message, state) {
    const outgoing = clone(message);
    const item = outgoing.params.item;
    const source = typeof item.text === 'string' ? item.text : state.source;
    const originalItem = { ...item, text: source };
    const key = this.itemKey(originalItem);
    let cached;
    try { cached = await this.store.get('items', key); } catch { /* Cache I/O cannot destroy a reply. */ }
    if (state.done) {
      item.text = state.emitted; this.down(outgoing); return;
    }
    const deltaMethod = state.type === 'plan' ? 'item/plan/delta' : 'item/agentMessage/delta';
    let consumedSource = 0;
    const emit = (chunk, meta) => {
      if (meta) consumedSource += meta.sourceLength;
      if (!chunk) return;
      state.emitted += chunk;
      this.down({ method: deltaMethod, params: { threadId: state.threadId, turnId: state.turnId, itemId: state.itemId, delta: chunk } });
    };
    if (cached?.source === source && typeof cached.text === 'string') {
      emit(cached.text);
    } else {
      const control = this.controller(state.threadId);
      if (state.interrupted) control.controller.abort();
      let warned = false;
      try {
        const result = await this.translator.translate(source, 'zh', {
          signal: control.controller.signal, fallback: true, onChunk: emit,
          onFallback: () => {
            if (!warned && !state.interrupted) this.warning(state.threadId, '回复翻译未通过校验或暂时不可用；未提交的部分保留原文。');
            warned = true;
          },
        });
        if (result.text !== state.emitted) throw new Error('Translation stream invariant violated');
      } catch (error) {
        // protect() can reject malformed input before emitting; preserve the complete original.
        if (!state.emitted) emit(source);
        else {
          // Preserve the uncommitted source tail instead of dropping it or replacing a visible prefix.
          emit(source.slice(consumedSource));
          this.warning(state.threadId, '翻译内部错误；已显示的译文保持不变，其余部分保留原文。');
          this.log(`Output translation internal error (${error.name || 'Error'}).`);
        }
      } finally { this.controllers.delete(control); }
      try { await this.store.set('items', key, { source, text: state.emitted, type: state.type }); }
      catch { this.warning(state.threadId, '译文历史缓存写入失败；本次显示正常，恢复会话时可能显示原文。'); }
    }
    // This is the only final text: exactly the bytes already emitted, no second translation.
    item.text = state.emitted; state.done = true;
    this.down(outgoing);
  }

  async restoreItem(item, threadId) {
    try {
      await this.restoreCachedItem(item, threadId);
    } catch {
      // History restoration is best effort. A failed cache read must not close
      // the native connection or drop an entire reply / history response.
      this.warning(threadId, '译文历史缓存读取失败；无法恢复的条目保留原文。');
    }
  }
  async restoreCachedItem(item, threadId) {
    if (item?.type === 'userMessage' && Array.isArray(item.content)) {
      let record = await this.store.get('user-items', [item.id, inputDigest(item.content)]);
      if (!record && item.clientId) record = await this.store.get('user-clients', [threadId, item.clientId]);
      if (!record) record = await this.store.get('user-content', [threadId, inputDigest(item.content)]);
      if (record && inputDigest(record.translated) === inputDigest(item.content)) {
        item.content = clone(record.original);
        try { await this.store.set('user-items', [item.id, inputDigest(record.translated)], record); } catch { /* Already restored in memory. */ }
      }
    } else if (TEXT_TYPES.has(item?.type) && typeof item.text === 'string') {
      const record = await this.store.get('items', this.itemKey(item));
      if (record?.source === item.text && typeof record.text === 'string') item.text = record.text;
    }
  }
  async restoreTurn(turn, threadId) {
    for (const item of turn.items || []) await this.restoreItem(item, threadId);
  }
  async restoreThread(thread) {
    for (const turn of thread.turns || []) await this.restoreTurn(turn, thread.id);
  }
  async restoreHistory(result, request) {
    if (result.thread) await this.restoreThread(result.thread);
    if (result.turn) await this.restoreTurn(result.turn, request.params.threadId);
    if (request.method === 'thread/list') for (const thread of result.data || []) await this.restoreThread(thread);
    if (request.method === 'thread/turns/list') for (const turn of result.data || []) await this.restoreTurn(turn, request.params.threadId);
    if (request.method === 'thread/items/list') for (const entry of result.data || []) await this.restoreItem(entry.item || entry, request.params.threadId);
  }
}
