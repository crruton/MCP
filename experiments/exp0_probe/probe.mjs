import { start } from './server.mjs';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

const PORT = 3100;
const ENDPOINT = `http://127.0.0.1:${PORT}/mcp`;
const V = '2026-07-28';

const meta = (capabilities = {}) => ({
  'io.modelcontextprotocol/protocolVersion': V,
  'io.modelcontextprotocol/clientInfo': { name: 'probe-client', version: '1.0.0' },
  'io.modelcontextprotocol/clientCapabilities': capabilities,
});

const tasksCap = { extensions: { 'io.modelcontextprotocol/tasks': {} } };

function headers(extra = {}, omit = []) {
  const h = {
    'Accept': 'application/json, text/event-stream',
    'Content-Type': 'application/json',
    'MCP-Protocol-Version': V,
    ...extra,
  };
  for (const k of omit) delete h[k];
  return h;
}

async function rpc(id, method, params, { hdrs = {}, omit = [] } = {}) {
  const body = { jsonrpc: '2.0', id, method, params };
  const res = await fetch(ENDPOINT, { method: 'POST', headers: headers(hdrs, omit), body: JSON.stringify(body) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = text; }
  return {
    status: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: json,
    raw: text.slice(0, 2000),
  };
}

const results = [];

async function probe(name, fn) {
  const started = Date.now();
  let out;
  try {
    out = await fn();
  } catch (e) {
    out = { error: String(e), stack: e?.stack };
  }
  results.push({ name, ms: Date.now() - started, ...out });
  console.log(`\n### ${name} -> HTTP ${out.status ?? 'ERR'} ${out.error ?? ''}`);
  console.log(JSON.stringify(out.body ?? out.raw ?? '', null, 2).slice(0, 1200));
}

await start(PORT);

// 1. server/discover with the Tasks extension declared by the client.
await probe('01_discover_with_tasks_declared', () =>
  rpc(1, 'server/discover', { _meta: meta(tasksCap) }, { hdrs: { 'Mcp-Method': 'server/discover' } }));

// 2. tools/call with correct mirrored headers.
await probe('02_tools_call_ok', () =>
  rpc(2, 'tools/call', { name: 'echo', arguments: { text: 'hi' }, _meta: meta() },
    { hdrs: { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'echo' } }));

// 3. Mcp-Name does not match params.name.
await probe('03_mcp_name_mismatch', () =>
  rpc(3, 'tools/call', { name: 'echo', arguments: { text: 'hi' }, _meta: meta() },
    { hdrs: { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'foo' } }));

// 4. Mcp-Method does not match the JSON-RPC method.
await probe('04_mcp_method_mismatch', () =>
  rpc(4, 'tools/call', { name: 'echo', arguments: { text: 'hi' }, _meta: meta() },
    { hdrs: { 'Mcp-Method': 'tools/list', 'Mcp-Name': 'echo' } }));

// 5. Unsupported protocol version.
await probe('05_unsupported_version', () =>
  rpc(5, 'server/discover', {
    _meta: { ...meta(), 'io.modelcontextprotocol/protocolVersion': '1900-01-01' },
  }, { hdrs: { 'MCP-Protocol-Version': '1900-01-01', 'Mcp-Method': 'server/discover' } }));

// 6. Legacy 2025-11-25 initialize handshake (stateless fallback).
await probe('06_legacy_initialize', () =>
  rpc(6, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'legacy-probe', version: '0.0.1' },
  }, { hdrs: { 'MCP-Protocol-Version': '2025-11-25' }, omit: ['Mcp-Method'] }));

// 6b. Follow-up legacy request after initialize (stateless fallback must still serve it).
await probe('06b_legacy_tools_call', () =>
  rpc('6b', 'tools/call', { name: 'echo', arguments: { text: 'legacy' } },
    { hdrs: { 'MCP-Protocol-Version': '2025-11-25' }, omit: ['Mcp-Method'] }));

// 7. tasks/get against a server that does not implement Tasks.
await probe('07_tasks_get_no_tasks', () =>
  rpc(7, 'tasks/get', { taskId: 'tsk_missing', _meta: meta(tasksCap) },
    { hdrs: { 'Mcp-Method': 'tasks/get', 'Mcp-Name': 'tsk_missing' } }));

// 8. Missing Mcp-Method header entirely.
await probe('08_missing_mcp_method', () =>
  rpc(8, 'tools/call', { name: 'echo', arguments: { text: 'hi' }, _meta: meta() },
    { hdrs: { 'Mcp-Name': 'echo' }, omit: ['Mcp-Method'] }));

// 9. Missing Mcp-Name header on tools/call.
await probe('09_missing_mcp_name', () =>
  rpc(9, 'tools/call', { name: 'echo', arguments: { text: 'hi' }, _meta: meta() },
    { hdrs: { 'Mcp-Method': 'tools/call' }, omit: ['Mcp-Name'] }));

// 10. Header protocol version vs _meta protocol version disagreement.
await probe('10_header_meta_version_mismatch', () =>
  rpc(10, 'server/discover', {
    _meta: { ...meta(), 'io.modelcontextprotocol/protocolVersion': '2025-11-25' },
  }, { hdrs: { 'Mcp-Method': 'server/discover' } }));

// 11. Unknown method with valid modern headers.
await probe('11_unknown_method', () =>
  rpc(11, 'tasks/list', { _meta: meta(tasksCap) },
    { hdrs: { 'Mcp-Method': 'tasks/list' } }));

// 12. A 1-second tool in a single call: keeps the call under the SDK timeout.
await probe('12_slow_tool_1s', () =>
  rpc(12, 'tools/call', { name: 'slow_echo', arguments: { text: 'slow', ms: 1000 }, _meta: meta() },
    { hdrs: { 'Mcp-Method': 'tools/call', 'Mcp-Name': 'slow_echo' } }));

writeFileSync(join(import.meta.dirname, 'results.json'), JSON.stringify(results, null, 2));
console.log('\nwrote results.json:', results.length, 'probes');
process.exit(0);
