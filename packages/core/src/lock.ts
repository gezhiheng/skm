import { promises as fs } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { exclusiveWrite, guard, missing, readFile } from './filesystem.js';

export async function withLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const lock = path.join(root, '.operation.lock');
  const token = randomUUID();
  const started = Date.now();
  while (true) {
    try {
      await exclusiveWrite(lock, JSON.stringify({ pid: process.pid, token }), root);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      await guard(lock, root);
      const content = await readFile(lock, root).catch(error => { if (missing(error)) return '{}'; throw error; });
      // An exclusive creator may still be writing its small ownership record.
      let current: { pid?: number; token?: string } = {};
      try { current = JSON.parse(content); } catch { /* Wait for the creator; malformed locks time out below. */ }
      if (typeof current.pid === 'number' && typeof current.token === 'string') {
        let alive = true;
        try { process.kill(current.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') alive = false; }
        if (!alive && await readFile(lock, root).catch(() => '') === JSON.stringify(current)) {
          await fs.unlink(lock).catch(error => { if (!missing(error)) throw error; });
          continue;
        }
      }
      if (Date.now() - started > 15_000) throw new Error(`Another SKM operation holds ${lock}; wait for it to finish. A malformed lock must be inspected manually.`);
      await new Promise(resolve => setTimeout(resolve, 20));
    }
  }
  try { return await operation(); }
  finally {
    await guard(lock, root);
    const current = await readFile(lock, root).catch(error => { if (missing(error)) return '{}'; throw error; });
    if ((JSON.parse(current) as { token?: string }).token === token) await fs.unlink(lock);
  }
}
