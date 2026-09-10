import { chmod, lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const source = fileURLToPath(new URL('../bin/codex-zh.mjs', import.meta.url));
const destination = join(homedir(), '.local', 'bin', 'codex-zh');
await mkdir(dirname(destination), { recursive: true });
await chmod(source, 0o755);
let existing;
try { existing = await lstat(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
if (existing) {
  if (!existing.isSymbolicLink() || resolve(dirname(destination), await readlink(destination)) !== source) {
    throw new Error(`Refusing to replace an existing command: ${destination}`);
  }
} else await symlink(source, destination);
console.log(`Installed ${destination}`);
console.log('Run codex-zh --doctor, then codex-zh from your project directory.');
