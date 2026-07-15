import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeEventFrame } from '@agentworkforce/events';
import { executeLocalRun } from './local-preview.js';
import type { RunRequestV1 } from './run-contracts.js';

test('executeLocalRun: redirected live read is denied before blocked target fetch', async () => {
  let allowedHits = 0;
  let blockedHits = 0;
  const blockedServer = createServer((_req, res) => {
    blockedHits += 1;
    res.statusCode = 204;
    res.end();
  });
  await new Promise<void>((resolve) => blockedServer.listen(0, '127.0.0.1', () => resolve()));
  const blockedAddress = blockedServer.address();
  assert.ok(blockedAddress && typeof blockedAddress === 'object');
  const blockedUrl = `http://127.0.0.1:${blockedAddress.port}/blocked`;

  const allowedServer = createServer((_req, res) => {
    allowedHits += 1;
    res.statusCode = 302;
    res.setHeader('location', blockedUrl);
    res.end();
  });
  await new Promise<void>((resolve) => allowedServer.listen(0, '127.0.0.1', () => resolve()));
  const allowedAddress = allowedServer.address();
  assert.ok(allowedAddress && typeof allowedAddress === 'object');
  const allowedUrl = `http://127.0.0.1:${allowedAddress.port}/allowed`;

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wf-preview-test-'));
  const bundlePath = path.join(tempDir, 'bundle.mjs');
  await writeFile(
    bundlePath,
    `export default async function handler() { await fetch('${allowedUrl}'); }\n`,
    'utf8'
  );

  const request = {
    schemaVersion: 1,
    agent: {
      schemaVersion: 1,
      sourceKind: 'single-file',
      sourcePath: path.join(tempDir, 'agent.ts'),
      sourceDigest: 'test-digest',
      handlerEntry: path.join(tempDir, 'agent.ts'),
      compileWarnings: [],
      persona: {
        id: 'redirect-test',
        intent: 'local-preview',
        tags: [],
        description: 'redirect test persona',
        skills: [],
        harness: 'claude',
        model: 'local-preview-stub',
        systemPrompt: 'test',
        harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
        cloud: true,
        onEvent: './agent.ts'
      },
      agent: {
        triggers: [],
        schedules: [{ name: 'scan', cron: '0 9 * * *' }],
        watch: []
      }
    },
    event: decodeEventFrame({
      id: 'evt_redirect',
      workspace: 'ws-local',
      type: 'cron.tick',
      occurredAt: '2026-07-15T09:00:00.000Z',
      name: 'scan',
      cron: '0 9 * * *'
    }).frame,
    mode: 'preview',
    inputs: {},
    policy: {
      reads: 'live',
      writes: 'preview',
      model: 'stub',
      shell: 'simulate',
      compose: 'preview',
      allowedHttp: [{ method: 'GET', urlGlob: allowedUrl }]
    },
    state: {
      schemaVersion: 1,
      kind: 'empty',
      fidelity: 'simulated'
    }
  } as unknown as RunRequestV1;

  try {
    const result = await executeLocalRun({ request, bundlePath });
    assert.equal(result.exitCode, 1);
    assert.equal(result.record.status, 'failed');
    assert.match(String(result.record.error ?? ''), /redirected live read/i);
    assert.equal(allowedHits, 1);
    assert.equal(blockedHits, 0);
  } finally {
    allowedServer.close();
    blockedServer.close();
    await rm(tempDir, { recursive: true, force: true });
  }
});
