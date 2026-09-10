import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');

// File names contain hashes only. Content is private local history, never a repository asset.
export class Store {
  constructor(root) { this.root = root; this.memory = new Map(); }
  async get(namespace, key) {
    const id = `${namespace}/${digest(key)}`;
    if (this.memory.has(id)) return structuredClone(this.memory.get(id));
    try {
      const value = JSON.parse(await readFile(join(this.root, `${id}.json`), 'utf8'));
      this.memory.set(id, value);
      return structuredClone(value);
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  async set(namespace, key, value) {
    const id = `${namespace}/${digest(key)}`;
    // Once text has been displayed it must remain canonical in this process,
    // even when the disk is full or the state directory becomes unwritable.
    this.memory.set(id, structuredClone(value));
    const directory = join(this.root, namespace);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = join(this.root, `${id}.json`);
    const temporary = `${destination}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: 'wx' });
      await rename(temporary, destination);
    } finally { await unlink(temporary).catch(() => {}); }
  }
}
