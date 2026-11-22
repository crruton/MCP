import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';
import { makeStore } from './store.mjs';

/**
 * Experiment B server.
 *
 * STORE=memory         in-process Map, worker in-process
 * STORE=file           JSON files, worker in-process
 * STORE=file-heartbeat JSON files + stale-heartbeat detector
 * STORE=external       JSON files, worker in a detached process
 * STORE=recover        external + re-dispatch orphaned tasks on boot
 *
 * IDEMPOTENT=0 disables the effectsCommitted guard (to show double execution).
 */

const MODE = process.env.STORE || 'memory';
const PORT = Number(process.env.PORT || 3120);
const STORE_DIR = process.env.STORE_DIR || join(import.meta.dirname, 'store-data');
const IDEMPOTENT = process.env.IDEMPOTENT !== '0';
const STALE_MS = Number(process.env.STALE_MS || 1000);

const store = MODE === 'memory' ? null : makeStore(STORE_DIR);
const mem = new Map();

const now = () => Date.now();

function get(taskId) {
  if (MODE === 'memory') return mem.get(taskId) || null;
  return store.read(taskId);
}

function put(rec) {
  rec.lastUpdatedAt = now();
  if (MODE === 'memory') mem.set(rec.taskId, rec);
  else store.write(rec);
}

function applyStaleDetection(rec) {
  if (!rec) return rec;
  // В режиме recover потерянного воркера возвращает boot scan, а не чтение статуса:
  // иначе статус успевает стать failed раньше, чем задача будет перезапущена.
  if (MODE !== 'file-heartbeat') return rec;
  if (rec.status === 'working' && rec.heartbeat && now() - rec.heartbeat > STALE_MS) {
    rec.status = 'failed';
    rec.statusMessage = 'worker lost (stale heartbeat)';
    rec.error = { code: -32603, message: 'worker lost' };
    put(rec);
  }
  return rec;
}

/** In-process worker: heartbeat every 100 ms, effect at 2 s, done at duration. */
function runInline(rec) {
  rec.workerPid = process.pid;
  rec.heartbeat = now();
  put(rec);

  const hb = setInterval(() => {
    const r = get(rec.taskId);
    if (!r || r.status !== 'working') {
      clearInterval(hb);
      return;
    }
    r.heartbeat = now();
    put(r);
  }, 100);

  const effectAt = Math.min(2000, Math.floor(rec.durationMs / 2));
  setTimeout(() => {
    const r = get(rec.taskId);
    if (!r || r.status !== 'working') return;
    if (!IDEMPOTENT || (r.effectsCommitted || 0) === 0) {
      if (store) store.applyEffect(r, 'deploy');
      if (r.status !== 'working') return;
      put(r);
    }
  }, effectAt);

  setTimeout(() => {
    clearInterval(hb);
    const r = get(rec.taskId);
    if (!r || r.status !== 'working') return;
    r.status = 'completed';
    r.statusMessage = 'done';
    r.result = { ok: true, durationMs: rec.durationMs, pid: process.pid };
    r.heartbeat = now();
    put(r);
    console.log('JOB_COMPLETED', r.taskId, 'effects', r.effectsCommitted || 0);
  }, rec.durationMs);
}

function runExternal(rec, { recovering = false } = {}) {
  put(rec);
  const args = [join(import.meta.dirname, 'worker.mjs'), STORE_DIR, rec.taskId, String(rec.durationMs)];
  if (!IDEMPOTENT) args.push('--no-idempotency');
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, IDEMPOTENT: IDEMPOTENT ? '1' : '0' },
  });
  child.unref();
  console.log(recovering ? 'REDISPATCHED' : 'SPAWNED', rec.taskId, 'pid', child.pid);
}

function startJob(durationMs) {
  const rec = {
    taskId: 'tsk_' + randomUUID().replaceAll('-', ''),
    status: 'working',
    statusMessage: 'started',
    createdAt: now(),
    lastUpdatedAt: now(),
    heartbeat: now(),
    durationMs,
    ttlMs: 3_600_000,
    pollIntervalMs: 1000,
    effectsCommitted: 0,
  };
  put(rec);
  const external = MODE === 'external' || MODE === 'recover';
  if (external) runExternal(rec);
  else runInline(rec);
  return rec;
}

function view(r) {
  return {
    taskId: r.taskId,
    status: r.status,
    statusMessage: r.statusMessage,
    createdAt: new Date(r.createdAt).toISOString(),
    lastUpdatedAt: new Date(r.lastUpdatedAt).toISOString(),
    ttlMs: r.ttlMs ?? null,
    pollIntervalMs: r.pollIntervalMs ?? 1000,
    ...(r.status === 'completed' ? { result: r.result } : {}),
    ...(r.status === 'failed' ? { error: r.error } : {}),
  };
}

function buildHandler() {
  return createMcpHandler(() => {
    const s = new McpServer({ name: `expB-${MODE}`, version: '1.0.0' });
    s.registerTool(
      'start_job',
      { description: 'Start job', inputSchema: z.object({ durationMs: z.number().int().min(1).max(120_000) }) },
      async ({ durationMs }) => {
        const r = startJob(durationMs);
        return {
          content: [{ type: 'text', text: JSON.stringify({ taskId: r.taskId, status: r.status }) }],
          structuredContent: { taskId: r.taskId, status: r.status },
        };
      },
    );
    s.registerTool(
      'get_job_status',
      { description: 'Status', inputSchema: z.object({ taskId: z.string() }) },
      async ({ taskId }) => {
        let r = get(taskId);
        if (!r) {
          return { isError: true, content: [{ type: 'text', text: 'Unknown or expired taskId' }] };
        }
        r = applyStaleDetection(r);
        return { content: [{ type: 'text', text: JSON.stringify(view(r)) }], structuredContent: view(r) };
      },
    );
    return s;
  });
}

if (MODE === 'recover') {
  // Boot scan ждёт, пока heartbeat действительно протухнет: сразу после рестарта
  // он ещё свежий, и раньше задача оставалась без перезапуска.
  setTimeout(async () => {
    const deadline = Date.now() + 10_000;
    for (;;) {
      const working = store.all().filter((r) => r.status === 'working');
      const stale = working.filter((r) => r.heartbeat && now() - r.heartbeat > STALE_MS);
      console.log('BOOT_SCAN', working.length, 'working,', stale.length, 'stale');
      if (working.length === 0 || stale.length === working.length) {
        for (const r of stale) {
          console.log('ORPHAN', r.taskId, 'stale for', now() - r.heartbeat, 'ms');
          runExternal(r, { recovering: true });
        }
        console.log('BOOT_SCAN_DONE');
        return;
      }
      if (Date.now() > deadline) {
        console.log('BOOT_SCAN_TIMEOUT');
        return;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 200);
}

const server = http.createServer(toNodeHandler(buildHandler()));
server.listen(PORT, '127.0.0.1', () => console.log(`expB server mode=${MODE} port=${PORT} idempotent=${IDEMPOTENT}`));
