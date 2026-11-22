import { start } from './server.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Simulated model loop. One "turn" = one tool call. `TURN_DELAY_MS` models
 * generation + transport latency between turns. The model has no sleep
 * primitive: every empty "working" answer costs one turn.
 *
 * Modes:
 *   poll           - get_job_status(waitMs=0), TURN_DELAY between turns
 *   longpoll       - get_job_status(waitMs=2500), TURN_DELAY between turns (fair)
 *   longpoll-burst - get_job_status(waitMs=2500), no client pause (lower bound)
 */

const ENDPOINT = 'http://127.0.0.1:3110/mcp';
const V = '2026-07-28';
const TURN_DELAY_MS = Number(process.env.TURN_DELAY_MS || 300);
const REPEATS = Number(process.env.REPEATS || 5);
const WAIT_MS = 2500; // 25 s budget, 10x accelerated

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let idc = 1;
async function callTool(name, args) {
  const body = {
    jsonrpc: '2.0',
    id: idc++,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      _meta: {
        'io.modelcontextprotocol/protocolVersion': V,
        'io.modelcontextprotocol/clientInfo': { name: 'sim-model', version: '1.0.0' },
        'io.modelcontextprotocol/clientCapabilities': {},
      },
    },
  };
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Accept': 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': V,
      'Mcp-Method': 'tools/call',
      'Mcp-Name': name,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (json.error) throw new Error(`${name}: ${JSON.stringify(json.error)}`);
  const sc = json.result?.structuredContent;
  return sc ?? JSON.parse(json.result.content[0].text);
}

async function runOne(durationMs, mode) {
  const started = Date.now();
  const longPoll = mode !== 'poll';
  const burst = mode === 'longpoll-burst';
  let turns = 0;
  let emptyTurns = 0;
  let bytes = 0;
  let nextTurnAt = started;

  const job = await callTool('start_job', { durationMs });
  turns++;
  bytes += JSON.stringify(job).length;

  for (;;) {
    // Fixed turn cadence: one model turn (including the tool round trip) is
    // TURN_DELAY_MS. A slow call eats into the next pause instead of adding to it.
    if (turns > 1 && !burst) {
      nextTurnAt += TURN_DELAY_MS;
      const wait = nextTurnAt - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const st = await callTool('get_job_status', {
      taskId: job.taskId,
      waitMs: longPoll ? WAIT_MS : 0,
    });
    turns++;
    bytes += JSON.stringify(st).length;
    if (st.status === 'working' || st.status === 'input_required') emptyTurns++;
    if (st.status === 'completed' || st.status === 'failed' || st.status === 'cancelled') {
      return { turns, emptyTurns, elapsedMs: Date.now() - started, resultBytes: bytes };
    }
    if (turns > 5000) throw new Error('turn explosion');
  }
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
const min = (xs) => Math.min(...xs);
const max = (xs) => Math.max(...xs);

await start(3110);

// 10x acceleration: the real jobs are 5 / 40 / 180 s, the test jobs 0.5 / 4 / 18 s.
const SCENARIOS = [
  { label: '5 s', durationMs: 500 },
  { label: '40 s', durationMs: 4000 },
  { label: '180 s', durationMs: 18_000 },
];
const MODES = ['poll', 'longpoll', 'longpoll-burst'];

const out = [];
for (const sc of SCENARIOS) {
  for (const mode of MODES) {
    const runs = [];
    for (let i = 0; i < REPEATS; i++) {
      runs.push(await runOne(sc.durationMs, mode));
      process.stdout.write('.');
    }
    const turns = runs.map((r) => r.turns);
    const elapsed = runs.map((r) => r.elapsedMs);
    out.push({
      scenario: sc.label,
      durationMs: sc.durationMs,
      mode,
      repeats: REPEATS,
      turns: { median: median(turns), min: min(turns), max: max(turns), all: turns },
      emptyTurns: { median: median(runs.map((r) => r.emptyTurns)) },
      elapsedMs: { median: median(elapsed), min: min(elapsed), max: max(elapsed) },
      resultBytes: { median: median(runs.map((r) => r.resultBytes)) },
    });
    console.log(`\n${sc.label} ${mode}: turns=${median(turns)} (${min(turns)}..${max(turns)}) elapsed=${median(elapsed)}ms`);
  }
}

const table = [];
for (const sc of SCENARIOS) {
  const pick = (m) => out.find((o) => o.scenario === sc.label && o.mode === m);
  const p = pick('poll');
  const l = pick('longpoll');
  const b = pick('longpoll-burst');
  table.push({
    scenario: sc.label,
    turnsPoll: p.turns.median,
    turnsLong: l.turns.median,
    turnsBurst: b.turns.median,
    speedupFair: +(p.turns.median / l.turns.median).toFixed(2),
    elapsedPoll: p.elapsedMs.median,
    elapsedLong: l.elapsedMs.median,
    elapsedBurst: b.elapsedMs.median,
  });
}

writeFileSync(
  join(import.meta.dirname, 'results.json'),
  JSON.stringify({ config: { turnDelayMs: TURN_DELAY_MS, waitMs: WAIT_MS, repeats: REPEATS }, runs: out, table }, null, 2),
);
console.log('\n== table ==');
console.table(table);
process.exit(0);
