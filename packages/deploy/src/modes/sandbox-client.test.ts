import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createProxySandboxClient, SANDBOX_BUNDLE_DIR } from './sandbox-client.js';
import type { BundleResult } from '../types.js';

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

function fakeFetch(
  handlers: Array<(call: RecordedCall) => Response | Promise<Response>>
): { fetch: typeof fetch; calls: RecordedCall[] } {
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
    const call: RecordedCall = {
      url,
      method: init?.method ?? 'GET',
      headers,
      ...(body !== undefined ? { body } : {})
    };
    calls.push(call);
    const handler = handlers[i];
    if (!handler) throw new Error(`fakeFetch: no handler at call index ${i}`);
    i += 1;
    return handler(call);
  }) as typeof fetch;
  return { fetch: impl, calls };
}

async function fixtureBundle(dir: string): Promise<BundleResult> {
  const runnerPath = path.join(dir, 'runner.mjs');
  const bundlePath = path.join(dir, 'agent.bundle.mjs');
  const personaCopyPath = path.join(dir, 'persona.json');
  const packageJsonPath = path.join(dir, 'package.json');
  await Promise.all([
    writeFile(runnerPath, 'runner', 'utf8'),
    writeFile(bundlePath, 'bundle', 'utf8'),
    writeFile(personaCopyPath, '{"id":"demo"}', 'utf8'),
    writeFile(packageJsonPath, '{}', 'utf8')
  ]);
  return { runnerPath, bundlePath, personaCopyPath, packageJsonPath, sizeBytes: 13 };
}

test('proxy client mints, uploads, execs, and destroys against cloud sandboxes endpoint', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-sandbox-'));
  try {
    const bundle = await fixtureBundle(dir);
    const { fetch: impl, calls } = fakeFetch([
      // POST /sandboxes
      () =>
        new Response(
          JSON.stringify({
            sandboxId: 'sbx_test',
            authMode: 'proxy',
            execUrl: 'https://cloud.example.com/api/v1/workspaces/ws/sandboxes/sbx_test/exec',
            filesUrl: 'https://cloud.example.com/api/v1/workspaces/ws/sandboxes/sbx_test/files'
          }),
          { status: 201 }
        ),
      // PUT /files
      () => new Response(null, { status: 204 }),
      // POST /exec (npm install)
      () => new Response(JSON.stringify({ exitCode: 0, output: 'added 1 package' }), { status: 200 }),
      // POST /exec (node runner.mjs)
      () => new Response(JSON.stringify({ exitCode: 0, output: 'runner ok' }), { status: 200 }),
      // DELETE /sandboxes/:id
      () => new Response(null, { status: 204 })
    ]);

    const client = createProxySandboxClient({
      cloudUrl: 'https://cloud.example.com',
      workspaceId: 'ws',
      workspaceToken: 'tok-secret',
      personaId: 'demo',
      fetchImpl: impl
    });

    const handle = await client.mint({
      label: 'wf-demo',
      env: { WORKFORCE_WORKSPACE_ID: 'ws' },
      integrations: {
        github: { triggers: [{ on: 'pull_request.opened' }] }
      }
    });
    assert.equal(handle.mode, 'proxy');
    assert.equal(handle.sandboxId, 'sbx_test');
    assert.equal(handle.id, 'proxy:sbx_test');

    await client.uploadBundle(handle, bundle);
    const runResult = await client.exec(handle, 'node runner.mjs', {
      cwd: SANDBOX_BUNDLE_DIR,
      timeoutSeconds: 60
    });
    assert.equal(runResult.exitCode, 0);
    assert.equal(runResult.output, 'runner ok');

    await client.destroy(handle);

    // Mint request shape.
    assert.equal(calls[0].url, 'https://cloud.example.com/api/v1/workspaces/ws/sandboxes');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].headers.authorization, 'Bearer tok-secret');
    assert.equal((calls[0].body as { purpose: string }).purpose, 'workforce-deploy');
    assert.equal((calls[0].body as { personaId: string }).personaId, 'demo');
    assert.deepEqual((calls[0].body as { integrations: unknown }).integrations, {
      github: { triggers: [{ on: 'pull_request.opened' }] }
    });

    // Upload PUT carries base64 file entries.
    assert.equal(calls[1].method, 'PUT');
    assert.match(calls[1].url, /\/sandboxes\/sbx_test\/files$/);
    const uploadBody = calls[1].body as { entries: Array<{ source: string; destination: string }> };
    assert.equal(uploadBody.entries.length, 4);
    const runnerEntry = uploadBody.entries.find((e) => e.destination.endsWith('/runner.mjs'));
    assert.ok(runnerEntry);
    assert.equal(Buffer.from(runnerEntry!.source, 'base64').toString('utf8'), 'runner');

    // Install exec.
    assert.equal(calls[2].method, 'POST');
    assert.match(calls[2].url, /\/sandboxes\/sbx_test\/exec$/);
    assert.match((calls[2].body as { command: string }).command, /^npm install/);

    // Runner exec.
    assert.equal((calls[3].body as { command: string }).command, 'node runner.mjs');

    // Delete by sandbox id.
    assert.equal(calls[4].method, 'DELETE');
    assert.match(calls[4].url, /\/sandboxes\/sbx_test$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('proxy client surfaces non-2xx mint responses with the cloud status + excerpt', async () => {
  const { fetch: impl } = fakeFetch([
    () => new Response('quota exceeded', { status: 429, statusText: 'Too Many Requests' })
  ]);
  const client = createProxySandboxClient({
    cloudUrl: 'https://cloud.example.com',
    workspaceId: 'ws',
    workspaceToken: 'tok',
    personaId: 'demo',
    fetchImpl: impl
  });
  await assert.rejects(
    () => client.mint({ label: 'wf-demo' }),
    /sandbox\(proxy\)\.mint: 429 Too Many Requests/
  );
});

test('proxy client omits empty integrations from mint requests', async () => {
  const { fetch: impl, calls } = fakeFetch([
    () =>
      new Response(
        JSON.stringify({
          sandboxId: 'sbx_test',
          authMode: 'proxy',
          execUrl: 'https://cloud.example.com/api/v1/workspaces/ws/sandboxes/sbx_test/exec',
          filesUrl: 'https://cloud.example.com/api/v1/workspaces/ws/sandboxes/sbx_test/files'
        }),
        { status: 201 }
      )
  ]);
  const client = createProxySandboxClient({
    cloudUrl: 'https://cloud.example.com',
    workspaceId: 'ws',
    workspaceToken: 'tok',
    personaId: 'demo',
    fetchImpl: impl
  });

  await client.mint({ label: 'wf-demo', integrations: {} });

  assert.equal('integrations' in (calls[0].body as Record<string, unknown>), false);
});

test('proxy client tolerates 404 on destroy (already deleted)', async () => {
  const { fetch: impl } = fakeFetch([
    () => new Response('not found', { status: 404, statusText: 'Not Found' })
  ]);
  const client = createProxySandboxClient({
    cloudUrl: 'https://cloud.example.com',
    workspaceId: 'ws',
    workspaceToken: 'tok',
    personaId: 'demo',
    fetchImpl: impl
  });
  // Construct a minimal proxy handle by hand (we don't want to mint first).
  await client.destroy({ id: 'proxy:x', sandboxId: 'x', mode: 'proxy' });
});

test('proxy client throws when npm install in the sandbox fails', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-sandbox-'));
  try {
    const bundle = await fixtureBundle(dir);
    const { fetch: impl } = fakeFetch([
      () =>
        new Response(
          JSON.stringify({
            sandboxId: 'sbx',
            authMode: 'proxy',
            execUrl: 'https://cloud.example.com/api/v1/workspaces/ws/sandboxes/sbx/exec',
            filesUrl: 'https://cloud.example.com/api/v1/workspaces/ws/sandboxes/sbx/files'
          }),
          { status: 201 }
        ),
      () => new Response(null, { status: 204 }),
      () => new Response(JSON.stringify({ exitCode: 1, output: 'EACCES' }), { status: 200 })
    ]);
    const client = createProxySandboxClient({
      cloudUrl: 'https://cloud.example.com',
      workspaceId: 'ws',
      workspaceToken: 'tok',
      personaId: 'demo',
      fetchImpl: impl
    });
    const handle = await client.mint({ label: 'wf' });
    await assert.rejects(() => client.uploadBundle(handle, bundle), /npm install failed \(exit 1\)/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
