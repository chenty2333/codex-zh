import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';

const exec = promisify(execFile);

function positiveInt(value, fallback, name) {
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} must be a positive integer`);
  return number;
}

export async function loadConfig(env = process.env, { needKey = true } = {}) {
  const passthrough = env.CODEX_ZH_PASSTHROUGH === '1';
  let apiKey = env.DEEPSEEK_API_KEY || '';
  let keySource = apiKey ? 'environment' : 'none';
  if (!apiKey && !passthrough) {
    try {
      const result = await exec('secret-tool', ['lookup', 'service', 'codex-zh', 'credential', 'deepseek-api-key'], { timeout: 5000 });
      apiKey = result.stdout.trim();
      if (apiKey) keySource = 'system keyring';
    } catch { /* An environment key also works on machines without libsecret. */ }
  }
  if (!apiKey && needKey && !passthrough) {
    throw new Error('DeepSeek key missing. Store it in the system keyring (see README) or set DEEPSEEK_API_KEY.');
  }
  const baseURL = new URL(env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');
  if (baseURL.username || baseURL.password || baseURL.search || baseURL.hash) throw new Error('DeepSeek base URL must not contain credentials, a query, or a fragment');
  if (baseURL.protocol !== 'https:' && !(baseURL.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(baseURL.hostname))) {
    throw new Error('DeepSeek requires HTTPS, except for loopback test servers');
  }
  return {
    apiKey, keySource, passthrough,
    model: env.DEEPSEEK_MODEL || 'deepseek-flash',
    baseURL: baseURL.href.replace(/\/$/, ''),
    timeoutMs: positiveInt(env.CODEX_ZH_TIMEOUT_MS, 60000, 'CODEX_ZH_TIMEOUT_MS'),
    batchChars: positiveInt(env.CODEX_ZH_BATCH_CHARS, 1800, 'CODEX_ZH_BATCH_CHARS'),
    stateDir: env.CODEX_ZH_STATE_DIR || join(env.XDG_STATE_HOME || join(homedir(), '.local', 'state'), 'codex-zh'),
    codexBin: env.CODEX_ZH_CODEX_BIN || 'codex',
  };
}
