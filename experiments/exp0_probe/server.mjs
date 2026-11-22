import http from 'node:http';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

/**
 * Minimal 2026-07-28 server on TS SDK v2 (2.4.0 / node 2.1.2).
 * Deliberately does NOT declare the Tasks extension: this is the
 * "server without Tasks" baseline used by probes 1-7.
 */
export function buildHandler() {
  return createMcpHandler(() => {
    const s = new McpServer({ name: 'probe', version: '0.0.1' });
    s.registerTool(
      'echo',
      { description: 'echo', inputSchema: z.object({ text: z.string() }) },
      async ({ text }) => ({ content: [{ type: 'text', text }] }),
    );
    s.registerTool(
      'slow_echo',
      { description: 'echo after a delay', inputSchema: z.object({ text: z.string(), ms: z.number() }) },
      async ({ text, ms }) => {
        await new Promise((r) => setTimeout(r, Math.min(ms, 55_000)));
        return { content: [{ type: 'text', text }] };
      },
    );
    return s;
  });
}

export function start(port = 3100) {
  const handler = buildHandler();
  const server = http.createServer(toNodeHandler(handler));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const port = Number(process.env.PORT || 3100);
  await start(port);
  console.log(`probe server on http://127.0.0.1:${port}/mcp`);
}
