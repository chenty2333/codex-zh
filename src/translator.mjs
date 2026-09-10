export class Translator {
  constructor(api, config) { this.api = api; this.config = config; }

  async translate(text, direction, { signal } = {}) {
    if (this.config.passthrough || !text) return text;
    signal?.throwIfAborted();
    const translated = await this.api.translate(text, direction, { signal });
    signal?.throwIfAborted();
    return translated;
  }
}
