import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync, appendFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export function makeStore(dir) {
  mkdirSync(dir, { recursive: true });
  const pathOf = (taskId) => join(dir, `${taskId}.json`);

  function read(taskId) {
    const p = pathOf(taskId);
    if (!existsSync(p)) return null;
    try {
      return JSON.parse(readFileSync(p, 'utf8'));
    } catch {
      return null;
    }
  }

  function write(rec) {
    const p = pathOf(rec.taskId);
    const tmp = p + '.tmp';
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, p); // atomic replace on the same volume
  }

  function all() {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => {
        try {
          return JSON.parse(readFileSync(join(dir, f), 'utf8'));
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  }

  function applyEffect(rec, label) {
    appendFileSync(join(dir, 'effects.log'), `${new Date().toISOString()} ${rec.taskId} ${label}\n`);
    rec.effectsCommitted = (rec.effectsCommitted || 0) + 1;
    rec.lastUpdatedAt = Date.now();
  }

  return { dir, read, write, all, applyEffect };
}
