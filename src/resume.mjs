const SELECT_METHODS = new Set(['thread/start', 'thread/resume', 'thread/fork']);
const REMOVE_METHODS = new Set(['thread/archive', 'thread/delete']);

// Keep only the selected session's identity and directory for the exit hint.
export class ResumeTracker {
  constructor(cwd, state = { session: null }) { this.cwd = cwd; this.state = state; this.pending = new Map(); }

  get session() { return this.state.session; }
  set session(value) { this.state.session = value; }

  fromClient(message) {
    if (message.id === undefined || (!SELECT_METHODS.has(message.method) && !REMOVE_METHODS.has(message.method))) return;
    const params = message.params || {};
    this.pending.set(message.id, { method: message.method, threadId: params.threadId, cwd: params.cwd, ephemeral: params.ephemeral });
  }

  fromServer(message) {
    if (message.method) {
      if (['thread/archived', 'thread/deleted'].includes(message.method) && message.params?.threadId === this.session?.id) this.session = null;
      return;
    }
    const request = this.pending.get(message.id);
    if (!request) return;
    this.pending.delete(message.id);
    if (message.error) return;
    if (REMOVE_METHODS.has(request.method)) {
      if (request.threadId === this.session?.id) this.session = null;
      return;
    }
    const thread = message.result?.thread;
    // The native TUI also starts ephemeral threads for background work.
    // They must not replace the user's resumable conversation.
    if (thread?.id && !request.ephemeral) this.session = { id: thread.id, cwd: thread.cwd || request.cwd || this.cwd };
  }

  disconnect() { this.pending.clear(); }
}

const shellQuote = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\"'\"'")}'`;

export function resumeCommand(session, { passthrough = false, profileArgs = [] } = {}) {
  const args = ['codex-zh', ...(passthrough ? ['--passthrough'] : []), ...profileArgs];
  args.push('resume', ...(session ? [session.id] : ['--all']));
  return args.map(shellQuote).join(' ');
}
