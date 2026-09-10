import { createHash, randomUUID } from 'node:crypto';
import { translationFailureReason } from './diagnostics.mjs';

const INPUT_METHODS = new Set(['turn/start', 'turn/steer']);
const TEXT_TYPES = new Set(['agentMessage', 'plan']);
const DELTA_METHODS = new Set(['item/agentMessage/delta', 'item/plan/delta']);
const clone = value => structuredClone(value);
const itemKey = p => JSON.stringify([p.threadId, p.turnId, p.itemId || p.item?.id]);
const inputDigest = input => createHash('sha256').update(JSON.stringify(input.map(part => {
  const normalized = { ...part };
  if (part.type === 'text') normalized.text_elements = (part.text_elements || []).map(element => ({ ...element, placeholder: element.placeholder ?? null }));
  if (['image', 'localImage'].includes(part.type)) normalized.detail = part.detail ?? null;
  return normalized;
}))).digest('hex');

// Translation is a transient presentation layer. No history is read, rewritten,
// or cached here. Only the active turn retains text needed for its final snapshot.
export class Bridge {
  constructor({ translator, config, sendUp, sendDown, log = () => {} }) {
    Object.assign(this, { translator, config, sendUp, sendDown, log });
    this.maxTextChars = config.maxTextChars ?? 128 * 1024;
    this.maxBufferedChars = config.maxBufferedChars ?? 4 * 1024 * 1024;
    this.maxLiveItems = config.maxLiveItems ?? 256;
    this.inputQueues = new Map(); this.outputQueues = new Map();
    this.states = new Map(); this.inputs = new Map(); this.inputRequests = new Map();
    this.controllers = new Set(); this.tasks = new Set();
    this.retainedChars = 0; this.retainedItems = 0; this.closed = false; this.capacityWarned = false;
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
  warning(threadId, message) { this.down({ method: 'warning', params: { threadId, message } }); }
  capacityWarning(threadId) {
    if (this.capacityWarned) return;
    this.capacityWarned = true;
    this.warning(threadId, '本轮翻译缓冲达到上限；超限的回复按原生方式显示原文。');
  }
  reserve(record) {
    // Reserve working space before accepting a request. Once it finishes,
    // account for the actual retained text without limiting the translation.
    const chars = 4 * this.maxTextChars;
    if (this.retainedItems >= this.maxLiveItems || this.retainedChars + chars > this.maxBufferedChars) return false;
    record.reservation = chars; this.retainedChars += chars; this.retainedItems++;
    return true;
  }
  resize(record, chars) {
    if (record.reservation === undefined) return;
    this.retainedChars -= record.reservation - chars; record.reservation = chars;
  }
  release(record) {
    if (record.reservation === undefined) return;
    this.retainedChars -= record.reservation; this.retainedItems--;
    delete record.reservation;
  }
  dropInput(record) {
    clearTimeout(record.timer);
    this.inputs.delete(record.clientId); this.inputRequests.delete(record.requestId);
    this.release(record);
  }
  dropState(state) { this.states.delete(state.key); this.release(state); }
  controller(threadId) {
    const record = { threadId, controller: new AbortController() };
    this.controllers.add(record); return record;
  }
  interrupt(threadId) {
    for (const record of this.controllers) if (record.threadId === threadId) record.controller.abort(new Error('Translation interrupted'));
    for (const state of this.states.values()) if (state.threadId === threadId) state.interrupted = true;
  }
  forgetThread(threadId) {
    this.interrupt(threadId);
    for (const state of this.states.values()) if (state.threadId === threadId) { state.abandoned = true; this.dropState(state); }
    for (const input of this.inputs.values()) if (input.threadId === threadId) this.dropInput(input);
  }
  close() {
    this.closed = true;
    for (const record of this.controllers) record.controller.abort();
    for (const record of this.inputs.values()) this.dropInput(record);
    for (const state of this.states.values()) this.dropState(state);
    this.inputRequests.clear();
    this.inputQueues.clear(); this.outputQueues.clear();
    this.retainedChars = 0; this.retainedItems = 0;
  }
  inputError(id, message) { this.down({ id, error: { code: -32001, message } }); }

  fromClient(message) {
    if (this.closed) return Promise.resolve();
    if (this.config.passthrough) { this.sendUp(message); return Promise.resolve(); }
    if (message.method === 'turn/interrupt') this.interrupt(message.params?.threadId);
    if (message.method === 'thread/unsubscribe') this.forgetThread(message.params?.threadId);
    // resume/read/list/fork and all other history/control requests are untouched.
    if (!INPUT_METHODS.has(message.method)) { this.sendUp(message); return Promise.resolve(); }
    const input = message.params?.input, threadId = message.params?.threadId;
    const originalTexts = Array.isArray(input) ? input.flatMap((part, index) => part.type === 'text' ? [{ index, part }] : []) : null;
    const originalChars = originalTexts ? JSON.stringify(originalTexts).length : Infinity;
    const record = { threadId, requestId: message.id, clientId: message.params?.clientUserMessageId || randomUUID(), turnId: null };
    if (originalChars > this.maxTextChars || this.inputs.has(record.clientId) || !this.reserve(record)) {
      this.inputError(message.id, '输入超出翻译缓冲上限或待处理消息过多，未提交。请缩短消息、稍后重试，或使用 codex-zh --passthrough。');
      return Promise.resolve();
    }
    record.originalTexts = clone(originalTexts);
    this.inputs.set(record.clientId, record);
    const control = this.controller(threadId);
    return this.queue(this.inputQueues, threadId, async () => {
      try {
        control.controller.signal.throwIfAborted();
        const outgoing = clone(message);
        for (const part of outgoing.params.input) {
          if (part.type !== 'text' || typeof part.text !== 'string') continue;
          part.text = await this.translator.translate(part.text, 'en', { signal: control.controller.signal });
          // Original byte offsets describe the source, not the translated text.
          // The original annotations remain available in the live input echo.
          if ('text_elements' in part) part.text_elements = [];
        }
        control.controller.signal.throwIfAborted();
        outgoing.params.clientUserMessageId = record.clientId;
        record.translatedDigest = inputDigest(outgoing.params.input);
        this.inputRequests.set(message.id, record);
        this.resize(record, originalChars);
        // A missing acknowledgement must not keep a submitted prompt forever.
        // Acknowledged prompts live only until their turn completes/unsubscribes.
        record.timer = setTimeout(() => this.dropInput(record), 60000); record.timer.unref();
        this.sendUp(outgoing);
      } catch (error) {
        this.dropInput(record);
        this.inputError(message.id, control.controller.signal.aborted ? '翻译已取消，原始消息未提交。' : '翻译请求失败，原始消息未提交。请重试，或使用 codex-zh --passthrough。');
        this.log(`Input translation stopped (${error.name || 'Error'}).`);
      } finally { this.controllers.delete(control); }
    });
  }

  fromServer(message) {
    if (this.closed) return Promise.resolve();
    if (this.config.passthrough) { this.down(message); return Promise.resolve(); }
    if (message.method && message.id !== undefined) { this.down(message); return Promise.resolve(); }
    if (!message.method && message.id !== undefined) {
      const input = this.inputRequests.get(message.id);
      this.inputRequests.delete(message.id);
      if (!input) { this.down(message); return Promise.resolve(); }
      if (message.error) this.dropInput(input);
      const turn = message.result?.turn;
      if (turn?.id) { input.turnId = turn.id; clearTimeout(input.timer); }
      if (!turn) { this.down(message); return Promise.resolve(); }
      return this.queue(this.outputQueues, input.threadId, () => {
        const outgoing = clone(message);
        this.restoreLiveTurn(outgoing.result.turn, input.threadId);
        this.down(outgoing);
      });
    }
    const params = message.params || {}, threadId = params.threadId || params.thread?.id;
    if (message.method === 'thread/closed' || message.method === 'thread/archived') this.forgetThread(threadId);
    if (message.method === 'item/started' && TEXT_TYPES.has(params.item?.type)) {
      const state = { key: itemKey(params), threadId, turnId: params.turnId, itemId: params.item.id, type: params.item.type, source: params.item.text || '', emitted: '', done: false, interrupted: false };
      if (state.source.length > this.maxTextChars || this.states.has(state.key) || !this.reserve(state)) {
        this.capacityWarning(threadId);
        return this.queue(this.outputQueues, threadId, () => this.down(message));
      }
      this.states.set(state.key, state);
      const outgoing = clone(message); outgoing.params.item.text = '';
      return this.queue(this.outputQueues, threadId, () => this.down(outgoing));
    }
    if (DELTA_METHODS.has(message.method)) {
      const state = this.states.get(itemKey(params));
      if (!state || state.raw) return this.queue(this.outputQueues, threadId, () => this.down(message));
      if (typeof params.delta !== 'string') return Promise.resolve();
      if (state.source.length + params.delta.length > this.maxTextChars) {
        const prefix = state.source; state.source = ''; state.raw = true;
        this.resize(state, 0); this.capacityWarning(threadId);
        return this.queue(this.outputQueues, threadId, () => {
          if (prefix) this.down({ method: message.method, params: { ...params, delta: prefix } });
          this.down(message);
        });
      }
      state.source += params.delta;
      return Promise.resolve();
    }
    if (message.method === 'item/completed' && TEXT_TYPES.has(params.item?.type)) {
      const state = this.states.get(itemKey(params));
      return this.queue(this.outputQueues, threadId, () => state ? this.completeText(message, state) : this.down(message));
    }
    if (message.method === 'turn/completed') {
      if (params.turn?.status === 'interrupted') this.interrupt(threadId);
      return this.queue(this.outputQueues, threadId, async () => {
        const matching = [...this.states.values()].filter(s => s.threadId === threadId && s.turnId === params.turn?.id);
        try {
          for (const state of matching.filter(s => !s.done && !s.raw)) {
            const original = params.turn?.items?.find(i => i.id === state.itemId);
            await this.completeText({ method: 'item/completed', params: { threadId, turnId: state.turnId, item: original || { type: state.type, id: state.itemId, text: state.source } } }, state);
          }
          const outgoing = clone(message);
          if (outgoing.params.turn) this.restoreLiveTurn(outgoing.params.turn, threadId);
          this.down(outgoing);
        } finally {
          for (const state of matching) this.dropState(state);
          for (const input of this.inputs.values()) if (input.threadId === threadId && input.turnId === params.turn?.id) this.dropInput(input);
          if (!this.retainedItems) this.capacityWarned = false;
        }
      });
    }
    if (params.item?.type === 'userMessage') return this.queue(this.outputQueues, threadId, () => {
      const outgoing = clone(message); this.restoreLiveInput(outgoing.params.item, threadId, params.turnId); this.down(outgoing);
    });
    this.down(message); return Promise.resolve();
  }

  async completeText(message, state) {
    if (state.abandoned) return;
    if (state.raw) { this.down(message); this.dropState(state); return; }
    const outgoing = clone(message), item = outgoing.params.item;
    const source = typeof item.text === 'string' ? item.text : state.source;
    if (state.done) { item.text = state.emitted; this.down(outgoing); return; }
    const deltaMethod = state.type === 'plan' ? 'item/plan/delta' : 'item/agentMessage/delta';
    if (source.length > this.maxTextChars) {
      this.capacityWarning(state.threadId);
      // Only the authoritative original is displayed when no source delta escaped.
      this.down({ method: deltaMethod, params: { threadId: state.threadId, turnId: state.turnId, itemId: state.itemId, delta: source } });
      this.down(outgoing); this.dropState(state); return;
    }
    const control = this.controller(state.threadId);
    if (state.interrupted) control.controller.abort();
    let text;
    try {
      text = await this.translator.translate(source, 'zh', { signal: control.controller.signal });
    } catch (error) {
      text = source;
      if (!state.abandoned && !this.closed && !state.interrupted) this.warning(state.threadId, `回复翻译失败（${translationFailureReason(error)}）；本条回复保留原文。`);
      this.log(`Output translation stopped (${error.name || 'Error'}).`);
    } finally { this.controllers.delete(control); }
    if (state.abandoned || this.closed) return;
    state.emitted = text; item.text = text; state.done = true; state.source = '';
    this.resize(state, text.length);
    if (text) this.down({ method: deltaMethod, params: { threadId: state.threadId, turnId: state.turnId, itemId: state.itemId, delta: text } });
    this.down(outgoing);
  }

  restoreLiveInput(item, threadId, turnId) {
    if (!Array.isArray(item.content)) return;
    const digest = inputDigest(item.content);
    const record = [...this.inputs.values()].find(input => input.threadId === threadId && input.translatedDigest === digest && (!input.turnId || input.turnId === turnId) && (!item.clientId || item.clientId === input.clientId));
    if (!record) return;
    record.turnId = turnId; clearTimeout(record.timer);
    for (const { index, part } of record.originalTexts) item.content[index] = clone(part);
  }
  restoreLiveTurn(turn, threadId) {
    for (const item of turn.items || []) {
      if (item.type === 'userMessage') this.restoreLiveInput(item, threadId, turn.id);
      else if (TEXT_TYPES.has(item.type)) {
        const state = this.states.get(itemKey({ threadId, turnId: turn.id, itemId: item.id }));
        if (state?.done) item.text = state.emitted;
      }
    }
  }
}
