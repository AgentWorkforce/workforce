import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import type { DeploymentAgent } from './list-command.js';
import {
  configureLocalSurfaceCommandForTest,
  parseLocalSurfaceArgs,
  runLocalSurface
} from './local-surface-command.js';

function fakeResponse(input: { ok: boolean; status?: number; json?: unknown; text?: string }): Response {
  return {
    ok: input.ok,
    status: input.status ?? (input.ok ? 200 : 500),
    json: async () => input.json,
    text: async () => input.text ?? ''
  } as unknown as Response;
}

function fakeEnrollment() {
  return {
    nodeId: 'node_1',
    nodeName: 'my-laptop',
    nodeToken: 'nt_live_abc',
    relayWorkspaceId: 'rws_1',
    relaycastUrl: 'https://relaycast.example.com',
    websocketUrl: 'wss://relaycast.example.com/v1/node/ws',
    enrolledAt: '2026-07-01T00:00:00.000Z'
  };
}

function deployedAgent(overrides: Partial<DeploymentAgent> = {}): DeploymentAgent {
  return {
    agentId: 'agent_1',
    personaId: 'persona-uuid-1',
    personaSlug: 'demo-persona',
    deployedName: 'demo-persona',
    status: 'active',
    createdAt: '2026-07-01T00:00:00.000Z',
    lastUsedAt: null,
    scheduleIds: [],
    deployedByUserId: 'user_1',
    ...overrides
  };
}

test('parseLocalSurfaceArgs requires a persona path', () => {
  assert.throws(() => parseLocalSurfaceArgs([]), /missing persona path/);
});

test('parseLocalSurfaceArgs parses flags and resolves the persona path', () => {
  const parsed = parseLocalSurfaceArgs([
    'demo.json',
    '--workspace',
    'ws_1',
    '--enrollment-token',
    'ocl_node_enr_abc',
    '--node-name',
    'my-laptop',
    '--json'
  ]);
  assert.ok(!('help' in parsed));
  if ('help' in parsed) return;
  assert.equal(parsed.workspace, 'ws_1');
  assert.equal(parsed.enrollmentToken, 'ocl_node_enr_abc');
  assert.equal(parsed.nodeName, 'my-laptop');
  assert.equal(parsed.json, true);
  assert.ok(parsed.personaPath.endsWith('demo.json'));
});

test('parseLocalSurfaceArgs -h returns help', () => {
  const parsed = parseLocalSurfaceArgs(['-h']);
  assert.deepEqual(parsed, { help: true });
});

function withMockedDeps(overrides: Parameters<typeof configureLocalSurfaceCommandForTest>[0]) {
  const writes: Array<{ path: string; contents: string; options: unknown }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const restore = configureLocalSurfaceCommandForTest({
    preflightPersona: (async (personaPath: string) => ({
      persona: { id: 'demo-persona', integrations: {} },
      agent: {},
      personaPath,
      personaDir: '/personas',
      onEventPath: '/personas/onEvent.ts',
      schedules: [],
      integrations: [],
      warnings: []
    })) as never,
    resolveWorkspaceToken: (async () => ({
      token: 'tok_workspace',
      workspace: 'ws_1'
    })) as never,
    fetchDeployments: (async () => [deployedAgent()]) as never,
    resolveActiveFleetNodeEnrollment: (() => undefined) as never,
    enrollFleetNode: (async () => ({
      nodeId: 'node_1',
      nodeName: 'my-laptop',
      nodeToken: 'nt_live_abc',
      relayWorkspaceId: 'rws_1',
      relaycastUrl: 'https://relaycast.example.com',
      websocketUrl: 'wss://relaycast.example.com/v1/node/ws'
    })) as never,
    upsertFleetNodeEnrollment: (() => undefined) as never,
    fetch: (async () => fakeResponse({ ok: true, json: { channel: 'local-surface-demo-persona' } })) as never,
    spawn: ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as unknown as ChildProcess;
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    }) as never,
    writeFile: (async (path: string, contents: string, options: unknown) => {
      writes.push({ path: String(path), contents: String(contents), options });
    }) as never,
    mkdir: (async () => undefined) as never,
    resolveLocalSurfaceEntry: () => '/node_modules/@agentworkforce/local-surface/dist/index.js',
    now: () => new Date('2026-07-15T00:00:00.000Z'),
    log: (message: string) => logs.push(message),
    error: (message: string) => errors.push(message),
    ...overrides
  });
  return { writes, logs, errors, restore };
}

test('runLocalSurface resolves the deployed persona UUID, reuses a persisted enrollment, calls the local-surface API, writes config, and shells to relay node up', async () => {
  let sawEnrollmentReuse = false;
  let capturedLocalSurfaceBody: unknown;
  const { writes, logs, restore } = withMockedDeps({
    resolveActiveFleetNodeEnrollment: (() => {
      sawEnrollmentReuse = true;
      return {
        nodeId: 'node_1',
        nodeName: 'my-laptop',
        nodeToken: 'nt_live_abc',
        relayWorkspaceId: 'rws_1',
        relaycastUrl: 'https://relaycast.example.com',
        websocketUrl: 'wss://relaycast.example.com/v1/node/ws',
        enrolledAt: '2026-07-01T00:00:00.000Z'
      };
    }) as never,
    enrollFleetNode: (async () => {
      throw new Error('should not redeem when a persisted enrollment exists');
    }) as never,
    fetch: (async (_url: string, init: { body?: string }) => {
      capturedLocalSurfaceBody = JSON.parse(init.body ?? '{}');
      return fakeResponse({ ok: true, json: { channel: 'local-surface-demo-persona', relayWorkspaceId: 'rws_1' } });
    }) as never
  });

  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json']);
    assert.equal(process.exitCode, 0);
    assert.ok(sawEnrollmentReuse);
    // The API call must use the resolved cloud DB UUID (personaId from the
    // deployments list), not the workforce persona.json's own slug id.
    assert.deepEqual(capturedLocalSurfaceBody, { workspaceId: 'ws_1', personaId: 'persona-uuid-1' });
    assert.equal(writes.length, 1);
    assert.ok(writes[0]!.contents.includes('defineWorkforcePersonaNode'));
    assert.ok(writes[0]!.contents.includes('"local-surface-demo-persona"'));
    assert.ok(writes[0]!.contents.includes('"tok_workspace"'));
    assert.ok(logs.some((line) => line.includes('relay node up --config')));
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface fails loud (does not proceed) when the persona has no active cloud deployment', async () => {
  const { errors, logs, restore } = withMockedDeps({
    fetchDeployments: (async () => []) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json']);
    assert.equal(process.exitCode, 1);
    assert.ok(
      errors.some(
        (line) => line.includes('no active cloud-side deployment') && line.includes('demo-persona')
      )
    );
    // Must not have gotten far enough to write a node config.
    assert.ok(!logs.some((line) => line.includes('wrote node config')));
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface treats a destroyed-only deployment the same as no deployment', async () => {
  const { errors, restore } = withMockedDeps({
    fetchDeployments: (async () => [deployedAgent({ status: 'destroyed' })]) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json']);
    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((line) => line.includes('no active cloud-side deployment')));
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

// Regression: the check must match cloud's real dispatch gate exactly
// (`eq(agents.status, "active")`, webhook-consumers.config.ts) — a looser
// `!== 'destroyed'` filter would let a persona whose latest deploy errored
// (persona-deploy.ts sets `status = 'error'` on failure) resolve a UUID,
// opt in, and report full success while cloud never routes it an event.
test('runLocalSurface treats an error-status-only deployment the same as no deployment', async () => {
  const { errors, restore } = withMockedDeps({
    fetchDeployments: (async () => [deployedAgent({ status: 'error' })]) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json']);
    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((line) => line.includes('no active cloud-side deployment')));
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface matches the deployment by personaSlug/deployedName, not the raw slug against personaId', async () => {
  let capturedBody: unknown;
  const { restore } = withMockedDeps({
    fetchDeployments: (async () => [
      deployedAgent({ personaId: 'uuid-xyz', personaSlug: 'demo-persona', deployedName: 'demo-persona' })
    ]) as never,
    resolveActiveFleetNodeEnrollment: (() => fakeEnrollment()) as never,
    fetch: (async (_url: string, init: { body?: string }) => {
      capturedBody = JSON.parse(init.body ?? '{}');
      return fakeResponse({ ok: true, json: { channel: 'ch' } });
    }) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json']);
    assert.equal(process.exitCode, 0);
    assert.deepEqual(capturedBody, { workspaceId: 'ws_1', personaId: 'uuid-xyz' });
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface prefers the active-status deployment when multiple rows match', async () => {
  let capturedBody: unknown;
  const { restore } = withMockedDeps({
    fetchDeployments: (async () => [
      deployedAgent({ personaId: 'uuid-old-stopped', status: 'stopped', createdAt: '2026-01-01T00:00:00.000Z' }),
      deployedAgent({ personaId: 'uuid-active', status: 'active', createdAt: '2026-06-01T00:00:00.000Z' })
    ]) as never,
    resolveActiveFleetNodeEnrollment: (() => fakeEnrollment()) as never,
    fetch: (async (_url: string, init: { body?: string }) => {
      capturedBody = JSON.parse(init.body ?? '{}');
      return fakeResponse({ ok: true, json: { channel: 'ch' } });
    }) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json']);
    assert.equal(process.exitCode, 0);
    assert.deepEqual(capturedBody, { workspaceId: 'ws_1', personaId: 'uuid-active' });
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface redeems --enrollment-token and persists it when no enrollment exists', async () => {
  let persisted: unknown;
  const { restore } = withMockedDeps({
    upsertFleetNodeEnrollment: ((record: unknown) => {
      persisted = record;
    }) as never
  });

  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json', '--enrollment-token', 'ocl_node_enr_abc']);
    assert.equal(process.exitCode, 0);
    assert.ok(persisted);
    assert.equal((persisted as { nodeToken: string }).nodeToken, 'nt_live_abc');
    assert.equal((persisted as { enrolledAt: string }).enrolledAt, '2026-07-15T00:00:00.000Z');
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface fails with a clear message when no enrollment exists and no token was supplied', async () => {
  const { errors, restore } = withMockedDeps({});
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json']);
    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((line) => line.includes('no fleet node enrollment found')));
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface surfaces a clear error when the local-surface API call fails', async () => {
  const { errors, restore } = withMockedDeps({
    resolveActiveFleetNodeEnrollment: (() => fakeEnrollment()) as never,
    fetch: (async () => fakeResponse({ ok: false, status: 403, text: 'Forbidden' })) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json']);
    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((line) => line.includes('/api/v1/fleet/local-surface failed: 403')));
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface --json prints setup info instead of shelling to relay node up', async () => {
  let spawnCalls = 0;
  const { logs, restore } = withMockedDeps({
    resolveActiveFleetNodeEnrollment: (() => fakeEnrollment()) as never,
    spawn: (() => {
      spawnCalls += 1;
      throw new Error('should not spawn in --json mode');
    }) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json', '--json']);
    assert.equal(spawnCalls, 0);
    const jsonLine = logs.find((line) => line.trim().startsWith('{'));
    assert.ok(jsonLine);
    const parsed = JSON.parse(jsonLine!);
    assert.equal(parsed.workspace, 'ws_1');
    assert.equal(parsed.channel, 'local-surface-demo-persona');
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface warns when the persona declares integrations (known local-credential gap)', async () => {
  const { errors, restore } = withMockedDeps({
    preflightPersona: (async (personaPath: string) => ({
      persona: { id: 'demo-persona', integrations: { github: {} } },
      agent: {},
      personaPath,
      personaDir: '/personas',
      onEventPath: '/personas/onEvent.ts',
      schedules: [],
      integrations: ['github'],
      warnings: []
    })) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json']);
    assert.ok(errors.some((line) => line.includes('does not mirror')));
  } finally {
    restore();
    process.exitCode = undefined;
  }
});
