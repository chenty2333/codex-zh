import { readdir, readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const excluded = new Set(['node_modules', '.git', '.state', '.test-state', 'coverage']);
let checked = 0;
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name) || entry.name === '.env') continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await walk(path);
    else if (entry.isFile()) {
      if (entry.name.endsWith('.mjs')) {
        const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`Syntax check failed: ${path}`);
        checked++;
      }
      const contents = await readFile(path, 'utf8');
      if (/\bsk-[A-Za-z0-9_-]{20,}\b/.test(contents)) throw new Error(`Possible API credential in project source: ${path}`);
    }
  }
}
await walk(root);
console.log(`Syntax checked ${checked} JavaScript modules; no API credentials detected in project source.`);
