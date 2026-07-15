import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeEventFrame } from '@agentworkforce/events';
import {
  __setPreviewWorkerSpawnForTest,
  executeLocalRun,
  stopChildProcess
} from './local-preview.js';
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

test('executeLocalRun: overall timeout tears the worker down and leaves no orphan staging directories', async () => {
  const previousOverall = process.env.WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS;
  const previousForceKill = process.env.WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS;
  process.env.WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS = '200';
  process.env.WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS = '100';

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wf-preview-timeout-'));
  const bundlePath = path.join(tempDir, 'bundle.mjs');
  await writeFile(
    bundlePath,
    'export default async function handler() { await new Promise(() => {}); }\n',
    'utf8'
  );

  const request = {
    schemaVersion: 1,
    agent: {
      schemaVersion: 1,
      sourceKind: 'single-file',
      sourcePath: path.join(tempDir, 'agent.ts'),
      sourceDigest: 'test-timeout-digest',
      handlerEntry: path.join(tempDir, 'agent.ts'),
      compileWarnings: [],
      persona: {
        id: 'timeout-test',
        intent: 'local-preview',
        tags: [],
        description: 'timeout test persona',
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
      id: 'evt_timeout',
      workspace: 'ws-local',
      type: 'cron.tick',
      occurredAt: '2026-07-15T09:00:00.000Z',
      name: 'scan',
      cron: '0 9 * * *'
    }).frame,
    mode: 'preview',
    inputs: {},
    policy: {
      reads: 'fixtures',
      writes: 'preview',
      model: 'stub',
      shell: 'simulate',
      compose: 'preview',
      allowedHttp: []
    },
    state: {
      schemaVersion: 1,
      kind: 'empty',
      fidelity: 'simulated'
    }
  } as unknown as RunRequestV1;

  const stagingRoot = path.join(process.cwd(), '.workforce');
  const before = await readdir(stagingRoot).catch((): string[] => []);

  try {
    await assert.rejects(
      () => executeLocalRun({ request, bundlePath }),
      /invoke worker timed out after 200ms/
    );
    const after = await readdir(stagingRoot).catch((): string[] => []);
    const leaked = after.filter((entry) =>
      entry.startsWith('local-preview-worker-') && !before.includes(entry)
    );
    assert.deepEqual(leaked, []);
  } finally {
    process.env.WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS = previousOverall;
    process.env.WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS = previousForceKill;
    await rm(tempDir, { recursive: true, force: true });
  }
});

test('stopChildProcess: settles after SIGKILL timeout even when close never arrives', async () => {
  const previousForceKill = process.env.WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS;
  const previousKillSettle = process.env.WF_LOCAL_PREVIEW_KILL_SETTLE_TIMEOUT_MS;
  process.env.WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS = '20';
  process.env.WF_LOCAL_PREVIEW_KILL_SETTLE_TIMEOUT_MS = '20';

  class FakeChild extends EventEmitter {
    connected = true;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    kills: string[] = [];
    kill(signal: NodeJS.Signals): boolean {
      this.kills.push(signal);
      return true;
    }
  }

  const child = new FakeChild();
  try {
    await assert.doesNotReject(() => stopChildProcess(child as unknown as import('node:child_process').ChildProcess));
    assert.deepEqual(child.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(child.listenerCount('close'), 0);
  } finally {
    process.env.WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS = previousForceKill;
    process.env.WF_LOCAL_PREVIEW_KILL_SETTLE_TIMEOUT_MS = previousKillSettle;
  }
});

test('executeLocalRun: no-close child stop path still rejects promptly and cleans staged dirs', async () => {
  const previousOverall = process.env.WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS;
  const previousForceKill = process.env.WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS;
  const previousKillSettle = process.env.WF_LOCAL_PREVIEW_KILL_SETTLE_TIMEOUT_MS;
  process.env.WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS = '40';
  process.env.WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS = '10';
  process.env.WF_LOCAL_PREVIEW_KILL_SETTLE_TIMEOUT_MS = '10';

  class FakeChild extends EventEmitter {
    connected = true;
    exitCode: number | null = null;
    signalCode: NodeJS.Signals | null = null;
    stderr = new EventEmitter() as EventEmitter & { setEncoding: (encoding: string) => void };
    kills: string[] = [];

    constructor() {
      super();
      this.stderr.setEncoding = () => undefined;
      setTimeout(() => {
        this.emit('message', { type: 'ready' });
      }, 0);
    }

    send(_message: unknown, callback?: (error: Error | null) => void): boolean {
      callback?.(null);
      return true;
    }

    kill(signal: NodeJS.Signals): boolean {
      this.kills.push(signal);
      return true;
    }
  }

  let fakeChild: FakeChild | undefined;
  __setPreviewWorkerSpawnForTest((() => {
    fakeChild = new FakeChild();
    return fakeChild;
  }) as unknown as typeof import('node:child_process').spawn);

  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'wf-preview-no-close-'));
  const bundlePath = path.join(tempDir, 'bundle.mjs');
  await writeFile(
    bundlePath,
    'export default async function handler() { return undefined; }\n',
    'utf8'
  );

  const request = {
    schemaVersion: 1,
    agent: {
      schemaVersion: 1,
      sourceKind: 'single-file',
      sourcePath: path.join(tempDir, 'agent.ts'),
      sourceDigest: 'test-no-close-digest',
      handlerEntry: path.join(tempDir, 'agent.ts'),
      compileWarnings: [],
      persona: {
        id: 'no-close-test',
        intent: 'local-preview',
        tags: [],
        description: 'no close test persona',
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
      id: 'evt_no_close',
      workspace: 'ws-local',
      type: 'cron.tick',
      occurredAt: '2026-07-15T09:00:00.000Z',
      name: 'scan',
      cron: '0 9 * * *'
    }).frame,
    mode: 'preview',
    inputs: {},
    policy: {
      reads: 'fixtures',
      writes: 'preview',
      model: 'stub',
      shell: 'simulate',
      compose: 'preview',
      allowedHttp: []
    },
    state: {
      schemaVersion: 1,
      kind: 'empty',
      fidelity: 'simulated'
    }
  } as unknown as RunRequestV1;

  const stagingRoot = path.join(process.cwd(), '.workforce');
  const before = await readdir(stagingRoot).catch((): string[] => []);

  try {
    await assert.rejects(
      () => executeLocalRun({ request, bundlePath }),
      /invoke worker timed out after 40ms/
    );
    const after = await readdir(stagingRoot).catch((): string[] => []);
    const leaked = after.filter((entry) =>
      entry.startsWith('local-preview-worker-') && !before.includes(entry)
    );
    assert.deepEqual(leaked, []);
    assert.ok(fakeChild);
    assert.deepEqual(fakeChild.kills, ['SIGTERM', 'SIGKILL']);
    assert.equal(fakeChild.listenerCount('close'), 0);
  } finally {
    __setPreviewWorkerSpawnForTest(undefined);
    process.env.WF_LOCAL_PREVIEW_OVERALL_TIMEOUT_MS = previousOverall;
    process.env.WF_LOCAL_PREVIEW_FORCE_KILL_TIMEOUT_MS = previousForceKill;
    process.env.WF_LOCAL_PREVIEW_KILL_SETTLE_TIMEOUT_MS = previousKillSettle;
    await rm(tempDir, { recursive: true, force: true });
  }
});
