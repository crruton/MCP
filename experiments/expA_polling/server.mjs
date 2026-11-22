import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { toNodeHandler } from '@modelcontextprotocol/node';
import * as z from 'zod/v4';

/**
 * Experiment A: hybrid server exposing ordinary tools (start / status / cancel)
 * while storing state in the exact shape a future native tasks/get would return.
 * Everything runs behind the real TS SDK v2 HTTP handler, one McpServer instance
 * per request, so per-request overhead is the real thing.
 */

const jobs = new Map(); // taskId -> record

const now = () => Date.now();

function createJob(durationMs) {
  const taskId = 'tsk_' + randomUUID().replaceAll('-', '');
  const rec = {
    taskId,
    status: 'working',
    statusMessage: 'started',
    createdAt: now(),
    lastUpdatedAt: now(),
    finishedAt: null,
    durationMs,
    result: null,
  };
  jobs.set(taskId, rec);
  setTimeout(() => {
    const r = jobs.get(taskId);
    if (!r || r.status !== 'working') return; // cancelled / gone
    r.status = 'completed';
    r.statusMessage = 'done';
    r.finishedAt = now();
    r.lastUpdatedAt = now();
    r.result = { echo: taskId, durationMs };
  }, durationMs);
  return rec;
}

function view(r) {
  return {
    taskId: r.taskId,
    status: r.status,
    statusMessage: r.statusMessage,
    createdAt: new Date(r.createdAt).toISOString(),
    lastUpdatedAt: new Date(r.lastUpdatedAt).toISOString(),
    ttlMs: 3_600_000,
    pollIntervalMs: 300,
    ...(r.status === 'completed' ? { result: r.result } : {}),
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

function buildHandler() {
  return createMcpHandler(() => {
    const s = new McpServer({ name: 'expA-hybrid', version: '1.0.0' });

    s.registerTool(
      'start_job',
      {
        description: 'Start a background job. Returns a durable taskId.',
        inputSchema: z.object({ durationMs: z.number().int().min(1).max(600_000) }),
      },
      async ({ durationMs }) => {
        const r = createJob(durationMs);
        return {
          content: [{ type: 'text', text: JSON.stringify({ taskId: r.taskId, status: r.status }) }],
          structuredContent: { taskId: r.taskId, status: r.status, pollIntervalMs: 300 },
        };
      },
    );

    s.registerTool(
      'get_job_status',
      {
        description:
          'Get job status. If waitMs > 0, the server long-polls internally and returns as soon as the job reaches a terminal state or the wait budget expires.',
        inputSchema: z.object({
          taskId: z.string(),
          waitMs: z.number().int().min(0).max(55_000).default(0),
        }),
      },
      async ({ taskId, waitMs }) => {
        const deadline = now() + Math.min(Math.max(waitMs, 0), 55_000);
        for (;;) {
          const r = jobs.get(taskId);
          if (!r) {
            return { isError: true, content: [{ type: 'text', text: 'Unknown or expired taskId' }] };
          }
          if (TERMINAL.has(r.status) || now() >= deadline) {
            return {
              content: [{ type: 'text', text: JSON.stringify(view(r)) }],
              structuredContent: view(r),
            };
          }
          await sleep(50); // production: pub/sub or BLPOP instead of store polling
        }
      },
    );

    s.registerTool(
      'cancel_job',
      {
        description: 'Cancel a job (cooperative).',
        inputSchema: z.object({ taskId: z.string() }),
      },
      async ({ taskId }) => {
        const r = jobs.get(taskId);
        if (!r) return { isError: true, content: [{ type: 'text', text: 'Unknown or expired taskId' }] };
        if (!TERMINAL.has(r.status)) {
          r.status = 'cancelled';
          r.statusMessage = 'cancelled by client';
          r.lastUpdatedAt = now();
        }
        return { content: [{ type: 'text', text: JSON.stringify(view(r)) }], structuredContent: view(r) };
      },
    );

    return s;
  });
}

export function start(port = 3110) {
  const server = http.createServer(toNodeHandler(buildHandler()));
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && process.argv[1].endsWith('server.mjs')) {
  const port = Number(process.env.PORT || 3110);
  await start(port);
  console.log(`expA server on http://127.0.0.1:${port}/mcp`);
}
