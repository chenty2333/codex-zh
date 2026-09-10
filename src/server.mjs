import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { WebSocketServer, WebSocket } from 'ws';
import { Bridge } from './bridge.mjs';

// A loopback, authenticated WebSocket transport for the unmodified native TUI.
// The upstream side is the unmodified Codex app-server's JSON-lines stdio transport.
export async function startServer({ translator, store, config, backendArgs = [], backendPrefix = [], cwd = process.cwd(), env = process.env, log = () => {}, spawnBackend }) {
  const token = randomBytes(32).toString('base64url');
  const server = createServer((_req, res) => { res.writeHead(404); res.end(); });
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024 * 1024, perMessageDeflate: false });
  const connections = new Set();
  let closing = false;
  server.on('upgrade', (req, socket, head) => {
    const expected = Buffer.from(`Bearer ${token}`);
    const actual = Buffer.from(req.headers.authorization || '');
    if (closing || req.headers.origin || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return;
    }
    if (connections.size) { socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n'); return; }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  wss.on('connection', socket => {
    const child = spawnBackend ? spawnBackend() : spawn(config.codexBin, [...backendPrefix, 'app-server', '--stdio', ...backendArgs], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const connection = { socket, child, bridge: null };
    connections.add(connection);
    let pendingBytes = 0, stopped = false, lineBuffer = '';
    const decoder = new StringDecoder('utf8');
    const sendDown = message => {
      if (socket.readyState !== WebSocket.OPEN) return;
      const payload = JSON.stringify(message);
      const bytes = Buffer.byteLength(payload); pendingBytes += bytes;
      if (pendingBytes > 8 * 1024 * 1024) child.stdout?.pause();
      socket.send(payload, error => {
        pendingBytes -= bytes;
        if (pendingBytes < 4 * 1024 * 1024) child.stdout?.resume();
        if (error) shutdown();
      });
    };
    const sendUp = message => {
      if (!stopped && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    const bridge = new Bridge({ translator, store, config, sendUp, sendDown, log });
    connection.bridge = bridge;
    const shutdown = () => {
      if (stopped) return; stopped = true;
      bridge.close(); connections.delete(connection);
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
    child.stdout.on('data', chunk => {
      lineBuffer += decoder.write(chunk);
      if (lineBuffer.length > 128 * 1024 * 1024) { log('Codex protocol frame exceeds size limit.'); shutdown(); return; }
      let end;
      while ((end = lineBuffer.indexOf('\n')) >= 0) {
        const line = lineBuffer.slice(0, end).trim(); lineBuffer = lineBuffer.slice(end + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          bridge.fromServer(message).catch(() => { log('Codex message processing failed.'); shutdown(); });
        } catch { log('Codex emitted an invalid protocol frame.'); shutdown(); }
      }
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
    async close() {
      if (closing) return; closing = true;
      for (const connection of connections) connection.shutdown();
      wss.close();
      await new Promise(resolve => server.close(resolve));
    },
  };
}
