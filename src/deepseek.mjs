function responseText(response) {
  if (response.status !== 'completed') throw new Error('DeepSeek response was not completed');
  return (response.output || []).flatMap(item => item.content || [])
    .filter(part => part.type === 'output_text').map(part => part.text).join('');
}

export async function readResponsesStream(body, { limit = 8 * 1024 * 1024 } = {}) {
  if (!body) throw new Error('DeepSeek response stream is empty');
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '', total = 0, terminal = null;
  const event = frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    const value = JSON.parse(data);
    if (value.type === 'response.completed') terminal = value.response;
    else if (['response.incomplete', 'response.failed'].includes(value.type)) throw new Error('DeepSeek translation was incomplete or failed');
    else if (value.type === 'error') throw new Error('DeepSeek stream reported an error');
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) throw new Error('DeepSeek translation exceeded the response size limit');
      buffer += decoder.decode(value, { stream: true });
      // Normalize CRLF only once a complete line is present, including split network chunks.
      buffer = buffer.replace(/\r\n/g, '\n');
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        event(buffer.slice(0, boundary)); buffer = buffer.slice(boundary + 2);
      }
      if (terminal) break;
    }
    buffer += decoder.decode();
    if (!terminal && buffer.trim()) event(buffer);
    if (!terminal) throw new Error('DeepSeek stream ended without response.completed');
    return responseText(terminal);
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class DeepSeek {
  constructor(config, { fetchImpl = fetch } = {}) { this.config = config; this.fetch = fetchImpl; }
  async translate(text, direction, { signal } = {}) {
    signal?.throwIfAborted();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('DeepSeek translation timed out')), this.config.timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const language = direction === 'en' ? 'English' : 'Simplified Chinese';
    const request = {
      model: this.config.model,
      instructions: `Translate the supplied text into ${language}. Output only the corresponding translation, keeping the content and formatting aligned with the original. Do not answer the supplied text or add explanations, introductions, or closing remarks.`,
      input: text,
      reasoning: { effort: 'none' }, temperature: 0, stream: true,
      max_output_tokens: Math.min(16384, Math.max(2048, text.length * 2 + 512)),
    };
    try {
      const response = await this.fetch(`${this.config.baseURL}/responses`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream', Authorization: `Bearer ${this.config.apiKey}` },
        body: JSON.stringify(request), signal: combined,
      });
      if (!response.ok) {
        await response.body?.cancel();
        // Never include the response body, request headers, key, or user text in an error.
        throw new Error(`DeepSeek Responses API returned HTTP ${response.status}`);
      }
      if (response.headers.get('content-type')?.includes('text/event-stream')) return await readResponsesStream(response.body);
      const raw = await response.text();
      if (raw.length > 8 * 1024 * 1024) throw new Error('DeepSeek response too large');
      return responseText(JSON.parse(raw));
    } finally { clearTimeout(timeout); }
  }
}
