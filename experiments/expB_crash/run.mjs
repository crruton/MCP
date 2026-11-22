import { spawn, spawnSync } from 'node:child_process';
import { rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

const PORT = 3120;
const ENDPOINT = `http://127.0.0.1:${PORT}/mcp`;
const V = '2026-07-28';
const ROOT = import.meta.dirname;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen() {
  return new Promise((resolve) => {
    const s = net.connect(PORT, '127.0.0.1');
    s.once('connect', () => { s.destroy(); resolve(true); });
    s.once('error', () => resolve(false));
    setTimeout(() => { s.destroy(); resolve(false); }, 500);
  });
}

async function waitPort(open = true, timeout = 15_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if ((await portOpen()) === open) return true;
    await sleep(100);
  }
  throw new Error(`port did not become ${open ? 'open' : 'closed'}`);
}

function startServer(env) {
  const p = spawn(process.execPath, [join(ROOT, 'server.mjs')], {
    env: { ...process.env, PORT: String(PORT), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', (d) => process.stdout.write(`    [srv] ${d}`));
  p.stderr.on('data', (d) => process.stdout.write(`    [srv!] ${d}`));
  return p;
}

function killTree(pid) {
  // No /T: the external worker is a detached child and must survive a server kill.
  spawnSync('taskkill', ['/F', '/PID', String(pid)], { stdio: 'ignore' });
}

async function startAndWait(env) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = startServer(env);
    try {
      await waitPort(true, 15_000);
      return p;
    } catch (e) {
      lastErr = e;
      killTree(p.pid);
      await sleep(700);
    }
  }
  throw lastErr;
}

let idc = 1;
async function rpc(method, params) {
  const body = { jsonrpc: '2.0', id: idc++, method, params: { ...params, _meta: {
    'io.modelcontextprotocol/protocolVersion': V,
    'io.modelcontextprotocol/clientInfo': { name: 'crash-runner', version: '1.0.0' },
    'io.modelcontextprotocol/clientCapabilities': {},
  } } };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': V,
      'Mcp-Method': method,
      'Mcp-Name': params.name ?? params.taskId ?? '',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) throw new Error(JSON.stringify(json.error));
  const sc = json.result?.structuredContent;
  if (sc) return sc;
  const txt = json.result?.content?.[0]?.text ?? '';
  try {
    return JSON.parse(txt);
  } catch {
    return { status: 'unknown', statusMessage: txt };
  }
}

const startJob = (durationMs) => rpc('tools/call', { name: 'start_job', arguments: { durationMs } });
const status = (taskId) => rpc('tools/call', { name: 'get_job_status', arguments: { taskId } });

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

/** Поллинг статуса до терминального состояния или до таймаута. */
async function waitTerminal(taskId, timeoutMs, intervalMs = 500) {
  const t0 = Date.now();
  let polls = 0;
  let st = { status: 'unknown' };
  while (Date.now() - t0 < timeoutMs) {
    st = await status(taskId).catch((e) => ({ error: String(e) }));
    polls++;
    if (TERMINAL.has(st.status)) break;
    await sleep(intervalMs);
  }
  return { st, polls, waitedMs: Date.now() - t0 };
}

function readRecord(storeDir, taskId) {
  const p = join(storeDir, `${taskId}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, 'utf8'));
}

function effects(storeDir) {
  const p = join(storeDir, 'effects.log');
  if (!existsSync(p)) return 0;
  return readFileSync(p, 'utf8').trim().split('\n').filter(Boolean).length;
}

async function scenario({ name, mode, idempotent = true, durationMs = 30_000, killAt = 1500, killWorker = false, waitTerminalMs = 10_000, repeats = 3 }) {
  const rows = [];
  for (let i = 0; i < repeats; i++) {
    const storeDir = join(ROOT, 'store-data', `${name}-${i}`);
    rmSync(storeDir, { recursive: true, force: true });
    const env = { STORE: mode, STORE_DIR: storeDir, IDEMPOTENT: idempotent ? '1' : '0' };
    const t0 = Date.now();
    let srv = await startAndWait(env);
    console.log(`  [timing] server up +${Date.now() - t0}ms`);
    const job = await startJob(durationMs);
    await sleep(killAt);
    const recBeforeKill = readRecord(storeDir, job.taskId);
    const tKill = Date.now();
    killTree(srv.pid);
    await waitPort(false);
    console.log(`  [timing] server killed +${Date.now() - t0}ms (port closed after ${Date.now() - tKill}ms)`);

    // Simulate a container/machine loss: the external worker dies with the host.
    if (killWorker && recBeforeKill?.workerPid) {
      try { killTree(recBeforeKill.workerPid); } catch {}
      console.log(`  [timing] worker killed +${Date.now() - t0}ms`);
    }

    srv = await startAndWait(env);
    console.log(`  [timing] server restarted +${Date.now() - t0}ms`);

    // Поллинг до терминального статуса вместо фиксированной паузы:
    // иначе результат зависит от того, успел ли воркер добежать до конца.
    const { st, polls, waitedMs } = await waitTerminal(job.taskId, waitTerminalMs);
    console.log(`  [timing] status=${st.status ?? 'unknown'} after ${polls} polls / ${waitedMs}ms`);

    const eff = effects(storeDir);
    rows.push({
      run: i + 1,
      status: st.status ?? 'unknown',
      statusMessage: st.statusMessage ?? st.error ?? '',
      effects: eff,
      polls,
      waitedMs,
      // Не «воркер выжил», а «в записи был pid воркера до убийства сервера»:
      // в B2 воркер живёт в процессе сервера и гибнет вместе с ним.
      workerPidRecorded: !!recBeforeKill?.workerPid,
    });
    killTree(srv.pid);
    await waitPort(false);
  }
  const summary = rows.map((r) => `${r.status}${r.effects != null ? `/eff=${r.effects}` : ''}`).join(', ');
  console.log(`  ${name}: ${summary}`);
  return { name, mode, rows };
}

console.log('== Experiment B: kill -9 and restart ==');
const ONLY = process.env.ONLY
  ? new Set(process.env.ONLY.split(',').map((s) => s.trim()).filter(Boolean))
  : null;
const pair = (n, fn) => [n, fn];
const plan = [
  // killAt = 3000 мс: побочный эффект наступает на 2-й секунде, иначе его просто не успевают записать.
  pair('B1-memory', () => scenario({ name: 'B1-memory', mode: 'memory', killAt: 3000 })),
  pair('B2-file', () => scenario({ name: 'B2-file', mode: 'file', killAt: 3000 })),
  pair('B3-file-heartbeat', () => scenario({ name: 'B3-file-heartbeat', mode: 'file-heartbeat', killAt: 3000 })),
  pair('B4-external-worker', () => scenario({
    name: 'B4-external-worker', mode: 'external', killAt: 3000, waitTerminalMs: 40_000, repeats: 2,
  })),
  pair('B5-recover-idempotent', () => scenario({
    name: 'B5-recover-idempotent', mode: 'recover', durationMs: 30_000, killAt: 5000, killWorker: true,
    waitTerminalMs: 45_000, repeats: 2,
  })),
  pair('B6-recover-no-idempotency', () => scenario({
    name: 'B6-recover-no-idempotency', mode: 'recover', idempotent: false, durationMs: 30_000, killAt: 5000,
    killWorker: true, waitTerminalMs: 45_000, repeats: 2,
  })),
];
const results = [];
for (const [name, fn] of plan) {
  if (ONLY && !ONLY.has(name)) continue;
  results.push(await fn());
}
if (results.length === 0) {
  console.error(`ONLY="${process.env.ONLY}" не совпал ни с одним сценарием. Доступны: ${plan.map(([n]) => n).join(', ')}`);
  process.exit(1);
}

const fs = await import('node:fs');
// Полный прогон всегда пишется в results-all.json, частичный — по именам сценариев.
const outName = results.length === plan.length
  ? 'results-all.json'
  : 'results-' + results.map((b) => b.name).join('_') + '.json';
fs.writeFileSync(join(ROOT, outName), JSON.stringify(results, null, 2));
console.log(`\nwrote ${outName}`);
process.exit(0);
