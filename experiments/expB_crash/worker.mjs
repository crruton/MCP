import { randomUUID } from 'node:crypto';
import { makeStore } from './store.mjs';

/**
 * One job worker process. Lives outside the MCP server process, so killing the
 * server does not stop the work.
 *
 *   node worker.mjs <storeDir> <taskId> <durationMs> [--no-idempotency]
 */
const [storeDir, taskId, durationArg, flag] = process.argv.slice(2);
const durationMs = Number(durationArg);
const idempotent = flag !== '--no-idempotency';
const store = makeStore(storeDir);

const rec = store.read(taskId);
if (!rec) {
  console.error('worker: no such task', taskId);
  process.exit(2);
}

const EFFECT_AT_MS = Math.min(2000, Math.floor(durationMs / 2));
const started = Date.now();

rec.workerPid = process.pid;
rec.status = 'working';
rec.statusMessage = 'running in external worker';
rec.lastUpdatedAt = started;
store.write(rec);

const hb = setInterval(() => {
  const r = store.read(taskId);
  if (!r) return;
  if (r.status === 'cancelled') {
    clearInterval(hb);
    process.exit(0);
  }
  r.heartbeat = Date.now();
  store.write(r);
}, 100);

let effectDone = false;
const effectTimer = setInterval(() => {
  if (effectDone) return;
  const r = store.read(taskId);
  if (!r) return;
  // Idempotency guard: an effect that already committed must not run twice,
  // even if the task is re-dispatched after a crash and timeout.
  if (idempotent && (r.effectsCommitted || 0) > 0) {
    effectDone = true;
    clearInterval(effectTimer);
    return;
  }
  store.applyEffect(r, 'deploy');
  store.write(r);
  effectDone = true;
  clearInterval(effectTimer);
}, EFFECT_AT_MS);

setTimeout(() => {
  clearInterval(hb);
  clearInterval(effectTimer);
  const r = store.read(taskId);
  if (!r || r.status === 'cancelled') process.exit(0);
  r.status = 'completed';
  r.statusMessage = 'done';
  r.heartbeat = Date.now();
  r.lastUpdatedAt = Date.now();
  r.result = { ok: true, durationMs, pid: process.pid };
  store.write(r);
  process.exit(0);
}, durationMs);
