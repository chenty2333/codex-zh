const HEADER = Buffer.from('Disconnected from this task. Any running work continues.');
const MAX_FOOTER_BYTES = 16384;
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Forward TUI bytes immediately, holding only a possible trailing exit summary.
// Match our own endpoint and the complete footer at EOF; other output is intact.
export class ExitOutput {
  constructor(write, { url, authEnv }) {
    this.write = write;
    this.pending = Buffer.alloc(0);
    const command = `codex --remote ${new URL(url).href} --remote-auth-token-env ${authEnv}`;
    this.prefix = `${HEADER}\nReconnect: ${command} resume `;
    this.suffix = `\nStop the current turn: run ${command} agents, select this task, and press ctrl + x.\n`;
    this.footer = new RegExp(`^${escapeRegex(this.prefix)}[0-9a-f-]{36}${escapeRegex(this.suffix)}(?:Token usage so far: ([^\\r\\n]+)\\n)?$`);
  }

  possibleFooter(text) {
    if (this.prefix.startsWith(text)) return true;
    if (!text.startsWith(this.prefix)) return false;
    let rest = text.slice(this.prefix.length);
    if (!/^[0-9a-f-]*$/.test(rest.slice(0, 36))) return false;
    if (rest.length < 36) return true;
    rest = rest.slice(36);
    if (this.suffix.startsWith(rest)) return true;
    if (!rest.startsWith(this.suffix)) return false;
    rest = rest.slice(this.suffix.length);
    const usage = 'Token usage so far: ';
    return usage.startsWith(rest) || (rest.startsWith(usage) && /^[^\r\n]*\n?$/.test(rest.slice(usage.length)));
  }

  push(chunk) {
    const bytes = this.pending.length ? Buffer.concat([this.pending, chunk]) : chunk;
    const start = bytes.lastIndexOf(HEADER);
    let keep = start >= 0 && bytes.length - start <= MAX_FOOTER_BYTES ? bytes.length - start : 0;
    if (keep) {
      const candidate = bytes.subarray(start).toString('utf8').replaceAll('\r\n', '\n').replace(/\r$/, '');
      if (!this.possibleFooter(candidate)) keep = 0;
    }
    if (!keep) {
      // Retain only a fragmented header prefix, never a partial UTF-8 character.
      for (let size = Math.min(HEADER.length - 1, bytes.length); size > 0; size--) {
        if (bytes.subarray(bytes.length - size).equals(HEADER.subarray(0, size))) { keep = size; break; }
      }
    }
    const end = bytes.length - keep;
    if (end) this.write(bytes.subarray(0, end));
    this.pending = keep ? Buffer.from(bytes.subarray(end)) : Buffer.alloc(0);
  }

  end() {
    const match = this.footer.exec(this.pending.toString('utf8').replaceAll('\r\n', '\n'));
    if (match?.[1]) this.write(Buffer.from(`Token usage: ${match[1]}\n`));
    else if (!match && this.pending.length) this.write(this.pending);
    this.pending = Buffer.alloc(0);
  }
}
