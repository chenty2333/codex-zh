#!/usr/bin/env node
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { loadConfig } from '../src/config.mjs';
import { DeepSeek } from '../src/deepseek.mjs';
import { Translator } from '../src/translator.mjs';
import { startServer } from '../src/server.mjs';
import { resumeCommand } from '../src/resume.mjs';

const HELP = `codex-zh — 原生 Codex TUI 的中英翻译代理

用法：codex-zh [--passthrough] [--] [Codex 原生参数]

  --help          显示本帮助（原生帮助：codex-zh -- --help）
  --doctor        检查 Codex 版本、模型和密钥来源，不调用模型
  --passthrough   原样转发，暂时关闭翻译

示例：
  codex-zh
  codex-zh -C /path/to/project
  codex-zh resume --last
  codex-zh resume --all
  codex-zh resume SESSION_ID
  codex-zh -- -m your-codex-model

进入后输入 /resume 选择原生历史；resume --all 可跨目录查找。
↑/↓ 输入历史与原生 Codex 共享，遵循原生 history 配置。
按 ID 恢复只需 codex-zh resume SESSION_ID，自动沿用原会话目录。
退出后复制最后一行的 codex-zh 恢复命令，不需要旧 ws 地址。

翻译模型：DeepSeek-V4.1-Flash（API 名：deepseek-flash），/responses。
原生 Codex 的模型和配置继续由 Codex 管理。
密钥：DEEPSEEK_API_KEY 或系统钥匙环 service=codex-zh credential=deepseek-api-key。
详细翻译行为和兼容边界见项目 README.md。
`;

async function main() {
  const input = process.argv.slice(2), native = [];
  let doctor = false, passthrough = false, separated = false;
  for (const arg of input) {
    if (!separated && arg === '--') { separated = true; continue; }
    if (!separated && arg === '--help') { console.log(HELP); return; }
    if (!separated && arg === '--doctor') { doctor = true; continue; }
    if (!separated && arg === '--passthrough') { passthrough = true; continue; }
    native.push(arg);
  }
  const config = await loadConfig({ ...process.env, ...(passthrough ? { CODEX_ZH_PASSTHROUGH: '1' } : {}) }, { needKey: !doctor });
  if (doctor) {
    const { stdout } = await promisify(execFile)(config.codexBin, ['--version'], { timeout: 10000 });
    console.log(JSON.stringify({ codex: stdout.trim(), translationModel: config.model, responsesEndpoint: `${config.baseURL}/responses`, keySource: config.keySource, translationPersistence: false, inputHistoryPersistence: 'native-config', maxTextChars: config.maxTextChars, maxBufferedChars: config.maxBufferedChars, maxLiveItems: config.maxLiveItems, passthrough: config.passthrough }, null, 2));
    return;
  }
  const backendArgs = [], backendPrefix = [];
  let backendCwd = process.cwd();
  for (let i = 0; i < native.length; i++) {
    const arg = native[i];
    if (arg === '--remote' || arg.startsWith('--remote=') || arg === '--remote-auth-token-env' || arg.startsWith('--remote-auth-token-env=')) throw new Error('codex-zh manages --remote. Start plain codex to connect to a different remote server.');
    if (['-c', '--config', '--enable', '--disable'].includes(arg)) {
      if (native[i + 1] === undefined) throw new Error(`Missing value for ${arg}`);
      backendArgs.push(arg, native[++i]);
    } else if (/^--(?:config|enable|disable)=/.test(arg) || arg === '--strict-config') backendArgs.push(arg);
    else if (arg === '-p' || arg === '--profile') {
      if (native[i + 1] === undefined) throw new Error(`Missing value for ${arg}`);
      backendPrefix.push(arg, native[++i]);
    } else if (arg.startsWith('--profile=')) backendPrefix.push(arg);
    else if (arg === '-C' || arg === '--cd') {
      if (native[i + 1] === undefined) throw new Error(`Missing value for ${arg}`);
      backendCwd = resolve(native[++i]);
    } else if (arg.startsWith('--cd=')) backendCwd = resolve(arg.slice(5));
  }
  const translator = new Translator(new DeepSeek(config), config);
  const server = await startServer({ config, translator, backendArgs, backendPrefix, cwd: backendCwd, log: text => console.error(`codex-zh: ${text}`) });
  const authEnv = 'CODEX_ZH_BRIDGE_TOKEN';
  const child = spawn(config.codexBin, ['--remote', server.url, '--remote-auth-token-env', authEnv, ...native], {
    stdio: 'inherit', env: { ...process.env, [authEnv]: server.token },
  });
  let childError = false;
  child.on('error', () => { childError = true; console.error('codex-zh: 无法启动原生 Codex。'); });
  const onTerm = () => child.kill('SIGTERM');
  // In an interactive terminal both processes receive SIGINT. Let the native TUI
  // decide whether it cancels a turn or exits; do not tear down the proxy on Ctrl+C.
  const onInt = () => {};
  process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
  const { code, signal } = await new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
  await server.close();
  if (!childError) {
    console.error('codex-zh: 本地会话已关闭，未完成的后台工作也会停止；上方临时 ws 重连地址已失效。');
    const command = resumeCommand(server.resumeSession, { passthrough: config.passthrough, profileArgs: backendPrefix });
    console.error(`codex-zh: ${server.resumeSession ? '恢复本次对话' : '选择历史对话'}：${command}`);
  }
  process.exitCode = childError ? 1 : code ?? (signal === 'SIGINT' ? 130 : 1);
}

main().catch(error => { console.error(`codex-zh: ${error.message}`); process.exitCode = 1; });
