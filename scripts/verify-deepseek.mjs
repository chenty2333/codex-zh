import { mkdir, writeFile } from 'node:fs/promises';
import { loadConfig } from '../src/config.mjs';
import { DeepSeek } from '../src/deepseek.mjs';
import { Translator } from '../src/translator.mjs';

const config = await loadConfig();
const directory = new URL('../.test-state/live/', import.meta.url).pathname;
await mkdir(directory, { recursive: true, mode: 0o700 });
const translator = new Translator(new DeepSeek(config), config);
const samples = [
  { direction: 'en', text: '请修复登录错误。不要修改 `src/auth.ts` 中的 `TIMEOUT_MS = 3000`。\n按钮文字为“提交”。' },
  { direction: 'zh', text: '# Result\n\nThe iPhone 17e uses the A19 chip.\n\n```ts\nconst label = "提交";\n```\n\nSee [details](https://example.test/auth?q=1).\n' },
];
const report = [];
for (const [index, sample] of samples.entries()) {
  const translation = await translator.translate(sample.text, sample.direction);
  report.push({ direction: sample.direction, source: sample.text, translation });
  console.log(`DeepSeek live request ${index + 1}/${samples.length}: completed`);
}
await writeFile(`${directory}/report.json`, JSON.stringify({ model: config.model, endpoint: `${config.baseURL}/responses`, requestedAt: new Date().toISOString(), samples: report }, null, 2), { mode: 0o600 });
console.log('DeepSeek whole-text requests completed; returned translations are saved for inspection.');
