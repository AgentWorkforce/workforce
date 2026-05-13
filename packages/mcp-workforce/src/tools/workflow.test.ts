import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowRun, workflowStatus } from './workflow.js';
import type { WorkforceMcpConfig } from '../config.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(handlers: Array<(call: RecordedCall) => Response | Promise<Response>>): {
  fetch: typeof fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  let i = 0;
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const entries =
        init.headers instanceof Headers
          ? Array.from(init.headers.entries())
          : Array.isArray(init.headers)
            ? init.headers
            : Object.entries(init.headers);
      for (const [k, v] of entries) headers[k.toLowerCase()] = String(v);
    }
    const body = init?.body ? JSON.parse(init.body.toString()) : undefined;
    const call: RecordedCall = { url, method: init?.method ?? 'GET', headers, ...(body !== undefined ? { body } : {}) };
    calls.push(call);
    const handler = handlers[i];
    if (!handler) throw new Error(`fakeFetch: no handler at call index ${i}`);
    i += 1;
    return handler(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

function config(over: Partial<WorkforceMcpConfig> = {}): WorkforceMcpConfig {
  return {
    workspaceId: 'ws-demo',
    cloudUrl: 'https://cloud.example.com',
    runtimeToken: 'tok-secret',
    writebackTimeoutMs: 0,
    ...over
  };
}

test('workflow.run POSTs to /workflows/run with the workspace token', async () => {
  const { fetch: impl, calls } = fakeFetch([
    () => new Response(JSON.stringify({ runId: 'run-1', status: 'pending' }), { status: 202 })
  ]);
  const result = await workflowRun({ name: 'pr-review', args: { prNumber: 5 } }, { config: config(), fetchImpl: impl });
  assert.equal(result.runId, 'run-1');
  assert.equal(result.status, 'pending');
  assert.equal(calls[0].url, 'https://cloud.example.com/api/v1/workspaces/ws-demo/workflows/run');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer tok-secret');
  assert.deepEqual(calls[0].body, { name: 'pr-review', args: { prNumber: 5 } });
});

test('workflow.run rejects when name is empty', async () => {
  await assert.rejects(
    () => workflowRun({ name: '' }, { config: config() }),
    /"name" is required/
  );
});

test('workflow.run surfaces non-2xx with the status + excerpt in the message', async () => {
  const { fetch: impl } = fakeFetch([
    () => new Response('rate limited', { status: 429, statusText: 'Too Many Requests' })
  ]);
  await assert.rejects(
    () => workflowRun({ name: 'pr-review' }, { config: config(), fetchImpl: impl }),
    /workflow\.run\("pr-review"\): 429 Too Many Requests/
  );
});

test('workflow.status GETs /workflows/runs/:id and forwards the response', async () => {
  const { fetch: impl, calls } = fakeFetch([
    () => new Response(JSON.stringify({ status: 'success', output: { ok: true } }), { status: 200 })
  ]);
  const result = await workflowStatus({ runId: 'run-7' }, { config: config(), fetchImpl: impl });
  assert.equal(result.status, 'success');
  assert.deepEqual(result.output, { ok: true });
  assert.equal(calls[0].method, 'GET');
  assert.equal(calls[0].url, 'https://cloud.example.com/api/v1/workspaces/ws-demo/workflows/runs/run-7');
});

test('workflow tools require WORKFORCE_RUNTIME_TOKEN', async () => {
  const { fetch: impl } = fakeFetch([]);
  await assert.rejects(
    () => workflowRun({ name: 'x' }, { config: config({ runtimeToken: undefined }), fetchImpl: impl }),
    /WORKFORCE_RUNTIME_TOKEN/
  );
});
