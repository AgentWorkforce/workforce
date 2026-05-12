import test from 'node:test';
import assert from 'node:assert/strict';
import { memorySave, memoryRecall } from './memory.js';
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
    supermemoryApiKey: 'sm_secret',
    writebackTimeoutMs: 0,
    ...over
  };
}

test('memory.save POSTs to supermemory with workspace + scope tags', async () => {
  const { fetch: impl, calls } = fakeFetch([
    () => new Response(JSON.stringify({ id: 'mem-1' }), { status: 200 })
  ]);
  const result = await memorySave(
    { content: 'digest published', tags: ['weekly-digest', 'weekly-digest'] },
    { config: config(), fetchImpl: impl }
  );
  assert.equal(result.id, 'mem-1');
  assert.equal(calls[0].url, 'https://api.supermemory.ai/v3/memories');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].headers.authorization, 'Bearer sm_secret');
  const body = calls[0].body as {
    content: string;
    containerTag: string;
    tags: string[];
    metadata: { workspaceId: string; scope: string };
  };
  assert.equal(body.content, 'digest published');
  assert.equal(body.containerTag, 'workforce:ws-demo');
  // Tags are deduped + workspace/scope tags injected.
  assert.deepEqual(body.tags, ['workspace:ws-demo', 'scope:workspace', 'weekly-digest']);
  assert.equal(body.metadata.scope, 'workspace');
});

test('memory.save rejects unknown scopes', async () => {
  await assert.rejects(
    () =>
      memorySave(
        { content: 'x', scope: 'galaxy' as unknown as 'workspace' },
        { config: config() }
      ),
    /invalid scope/
  );
});

test('memory.recall POSTs to /v3/search and normalizes the response shape', async () => {
  const { fetch: impl, calls } = fakeFetch([
    () =>
      new Response(
        JSON.stringify({
          results: [
            {
              id: 'm1',
              content: 'note one',
              tags: ['scope:workspace'],
              metadata: { scope: 'workspace' },
              createdAt: '2026-05-12T09:00:00Z'
            },
            {
              id: 'm2',
              memory: 'note two',
              created_at: '2026-05-11T08:00:00Z'
            }
          ]
        }),
        { status: 200 }
      )
  ]);
  const result = await memoryRecall(
    { query: 'digest', limit: 5 },
    { config: config(), fetchImpl: impl }
  );
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].id, 'm1');
  assert.equal(result.items[0].content, 'note one');
  // Falls back to `memory` field when `content` is missing.
  assert.equal(result.items[1].content, 'note two');
  // Falls back to default scope and accepts snake_case createdAt.
  assert.equal(result.items[1].scope, 'workspace');
  assert.equal(result.items[1].createdAt, '2026-05-11T08:00:00Z');
  assert.equal(calls[0].url, 'https://api.supermemory.ai/v3/search');
  const body = calls[0].body as { q: string; containerTag: string; limit: number };
  assert.equal(body.q, 'digest');
  assert.equal(body.containerTag, 'workforce:ws-demo');
  assert.equal(body.limit, 5);
});

test('memory.recall enforces a 1-50 limit range', async () => {
  await assert.rejects(
    () => memoryRecall({ query: 'q', limit: 0 }, { config: config() }),
    /"limit" must be 1-50/
  );
  await assert.rejects(
    () => memoryRecall({ query: 'q', limit: 51 }, { config: config() }),
    /"limit" must be 1-50/
  );
});

test('memory tools require SUPERMEMORY_API_KEY', async () => {
  await assert.rejects(
    () => memorySave({ content: 'x' }, { config: config({ supermemoryApiKey: undefined }) }),
    /SUPERMEMORY_API_KEY/
  );
  await assert.rejects(
    () => memoryRecall({ query: 'q' }, { config: config({ supermemoryApiKey: undefined }) }),
    /SUPERMEMORY_API_KEY/
  );
});
