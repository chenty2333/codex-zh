import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer, WebSocket } from 'ws';
import { Bridge } from './bridge.mjs';
import { ResumeTracker } from './resume.mjs';

// A loopback, authenticated WebSocket transport for the unmodified native TUI.
// The upstream side is the unmodified Codex app-server's JSON-lines stdio transport.
export async function startServer({ translator, config, backendArgs = [], backendPrefix = [], cwd = process.cwd(), env = process.env, log = () => {}, spawnBackend }) {
  const token = randomBytes(32).toString('base64url');
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024, perMessageDeflate: false });
  const connections = new Set();
  const resumeState = { session: null };
  let closing = false;
  server.on('upgrade', (req, socket, head) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(req.headers.authorization || '');
    if (closing || req.headers.origin || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', socket => {
    // The native /resume picker opens a second connection while the main TUI
    // stays connected. Each stdio client needs its own protocol state/backend;
    // all backends inherit the same CODEX_HOME and share native session storage.
    const resume = new ResumeTracker(cwd, resumeState);
    const child = spawnBackend ? spawnBackend() : spawn(config.codexBin, [...backendPrefix, 'app-server', '--stdio', ...backendArgs], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const connection = { socket, child, bridge: null };
    connections.add(connection);
    let pendingBytes = 0, pendingWorkBytes = 0, pendingFrames = 0;
    let stopped = false, lineBuffer = '', pumping = false;
    const decoder = new StringDecoder('utf8');
    const canRead = () => !stopped && pendingBytes < 8 * 1024 * 1024 && pendingWorkBytes < 8 * 1024 * 1024 && pendingFrames < 128;
    const updateReadState = () => { if (canRead()) child.stdout?.resume(); else child.stdout?.pause(); };
    const sendDown = message => {
      if (socket.readyState !== WebSocket.OPEN) return;
      resume.fromServer(message);
      const payload = JSON.stringify(message);
      const bytes = Buffer.byteLength(payload); pendingBytes += bytes;
      updateReadState();
      socket.send(payload, error => {
        pendingBytes -= bytes;
        if (error) shutdown();
        pump(); updateReadState();
      });
    };
    const sendUp = message => {
      if (!stopped && !child.stdin.destroyed) {
        resume.fromClient(message);
        child.stdin.write(`${JSON.stringify(message)}\n`);
      }
    };
    const bridge = new Bridge({ translator, config, sendUp, sendDown, log });
    connection.bridge = bridge;
    const shutdown = () => {
      if (stopped) return; stopped = true;
      bridge.close(); connections.delete(connection);
      resume.disconnect();
      child.stdin?.end();
      if (child.exitCode === null && !child.killed) child.kill('SIGTERM');
      const force = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 2500); force.unref();
      if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    };
    connection.shutdown = shutdown;
    socket.on('message', (data, isBinary) => {
      try {
        if (isBinary) throw new Error('Binary protocol frame');
        const message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid protocol envelope');
        bridge.fromClient(message).catch(() => { log('Client message processing failed.'); shutdown(); });
      } catch { socket.close(1003, 'Invalid JSON-RPC frame'); }
    });
    socket.on('close', shutdown); socket.on('error', shutdown);
    // Bound queued native frames as well as text retained by the translator.
    // Translation does not depend on Codex, so pausing stdout here cannot block
    // its own completion. The separate stdin/control path stays available.
    const pump = () => {
      if (pumping || stopped) return;
      pumping = true;
      try {
        let end;
        while (canRead() && (end = lineBuffer.indexOf('\n')) >= 0) {
          const line = lineBuffer.slice(0, end).trim(); lineBuffer = lineBuffer.slice(end + 1);
          if (!line) continue;
          let message;
          try { message = JSON.parse(line); }
          catch { log('Codex emitted an invalid protocol frame.'); shutdown(); break; }
          const bytes = Buffer.byteLength(line);
          pendingFrames++; pendingWorkBytes += bytes;
          Promise.resolve().then(() => bridge.fromServer(message)).catch(() => {
            log('Codex message processing failed.'); shutdown();
          }).finally(() => {
            pendingFrames--; pendingWorkBytes -= bytes;
            pump(); updateReadState();
          });
        }
      } finally { pumping = false; updateReadState(); }
    };
    child.stdout.on('data', chunk => {
      lineBuffer += decoder.write(chunk);
      if (lineBuffer.length > 128 * 1024 * 1024) {
        log('Codex protocol frame exceeds size limit.'); shutdown(); return;
      }
      pump();
    });
    // Drain stderr without persisting credentials or user material. Protocol errors are surfaced by Codex itself.
    child.stderr?.resume();
    child.stdin.on('error', shutdown);
    child.on('error', () => { log('Could not start Codex app-server. Check CODEX_ZH_CODEX_BIN.'); socket.close(1011, 'Codex could not start'); shutdown(); });
    child.on('exit', code => { if (!stopped && !closing && code) log(`Codex app-server exited with code ${code}.`); shutdown(); });
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return {
    url: `ws://127.0.0.1:${server.address().port}`, token, connections,
    get resumeSession() { return resumeState.session; },
    async close() {
      if (closing) return; closing = true;
      for (const connection of connections) connection.shutdown();
      wss.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
