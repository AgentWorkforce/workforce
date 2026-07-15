import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import {
  configureLocalSurfaceCommandForTest,
  parseLocalSurfaceArgs,
  runLocalSurface
} from './local-surface-command.js';

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
    '--channel',
    'local-surface-demo',
    '--node-name',
    'my-laptop',
    '--json'
  ]);
  assert.ok(!('help' in parsed));
  if ('help' in parsed) return;
  assert.equal(parsed.workspace, 'ws_1');
  assert.equal(parsed.enrollmentToken, 'ocl_node_enr_abc');
  assert.equal(parsed.channel, 'local-surface-demo');
  assert.equal(parsed.nodeName, 'my-laptop');
  assert.equal(parsed.json, true);
  assert.ok(parsed.personaPath.endsWith('demo.json'));
});

test('parseLocalSurfaceArgs -h returns help', () => {
  const parsed = parseLocalSurfaceArgs(['-h']);
  assert.deepEqual(parsed, { help: true });
});

function fakeEnrollment(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    nodeId: 'node_1',
    nodeName: 'my-laptop',
    nodeToken: 'nt_live_abc',
    relayWorkspaceId: 'rws_1',
    relaycastUrl: 'https://relaycast.example.com',
    websocketUrl: 'wss://relaycast.example.com/v1/node/ws',
    enrolledAt: '2026-07-01T00:00:00.000Z',
    ...overrides
  };
}

/**
 * In-memory fake for the `readFile`/`writeFile` pair `resolveChannelBinding`
 * uses to persist the `--channel` → state.json cache, so tests can assert
 * the cache actually round-trips across two `runLocalSurface` calls without
 * touching the real filesystem.
 */
function fakeStateFile() {
  let contents: string | undefined;
  return {
    readFile: (async () => {
      if (contents === undefined) {
        const err = new Error('ENOENT') as NodeJS.ErrnoException;
        err.code = 'ENOENT';
        throw err;
      }
      return contents;
    }) as never,
    writeFile: (async (_path: string, data: string) => {
      contents = data;
    }) as never,
    get raw() {
      return contents;
    }
  };
}

function withMockedDeps(overrides: Parameters<typeof configureLocalSurfaceCommandForTest>[0]) {
  const writes: Array<{ path: string; contents: string; options: unknown }> = [];
  const logs: string[] = [];
  const errors: string[] = [];
  const state = fakeStateFile();
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
    resolveActiveFleetNodeEnrollment: (() => undefined) as never,
    enrollFleetNode: (async () => fakeEnrollment()) as never,
    upsertFleetNodeEnrollment: (() => undefined) as never,
    spawn: ((_cmd: string, _args: string[]) => {
      const child = new EventEmitter() as unknown as ChildProcess;
      queueMicrotask(() => child.emit('exit', 0, null));
      return child;
    }) as never,
    readFile: state.readFile,
    writeFile: (async (targetPath: string, contents: string, options: unknown) => {
      if (String(targetPath).endsWith('state.json')) {
        await (state.writeFile as (p: string, c: string) => Promise<void>)(String(targetPath), String(contents));
        return;
      }
      writes.push({ path: String(targetPath), contents: String(contents), options });
    }) as never,
    mkdir: (async () => undefined) as never,
    resolveLocalSurfaceEntry: () => '/node_modules/@agentworkforce/local-surface/dist/index.js',
    now: () => new Date('2026-07-15T00:00:00.000Z'),
    log: (message: string) => logs.push(message),
    error: (message: string) => errors.push(message),
    ...overrides
  });
  return { writes, logs, errors, state, restore };
}

test('runLocalSurface reuses a persisted enrollment, resolves --channel, writes config, and shells to relay node up', async () => {
  let sawEnrollmentReuse = false;
  const { writes, logs, restore } = withMockedDeps({
    resolveActiveFleetNodeEnrollment: (() => {
      sawEnrollmentReuse = true;
      return fakeEnrollment();
    }) as never,
    enrollFleetNode: (async () => {
      throw new Error('should not redeem when a persisted enrollment exists');
    }) as never
  });

  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json', '--channel', 'local-surface-demo-persona']);
    assert.equal(process.exitCode, 0);
    assert.ok(sawEnrollmentReuse);
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

test('runLocalSurface redeems --enrollment-token and persists it when no enrollment exists', async () => {
  let persisted: unknown;
  const { restore } = withMockedDeps({
    upsertFleetNodeEnrollment: ((record: unknown) => {
      persisted = record;
    }) as never
  });

  try {
    process.exitCode = undefined;
    await runLocalSurface([
      '/personas/demo.json',
      '--enrollment-token',
      'ocl_node_enr_abc',
      '--channel',
      'local-surface-demo-persona'
    ]);
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
    await runLocalSurface(['/personas/demo.json', '--channel', 'local-surface-demo-persona']);
    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((line) => line.includes('no fleet node enrollment found')));
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface fails with a clear message when no channel is cached and --channel was not passed', async () => {
  const { errors, restore } = withMockedDeps({
    resolveActiveFleetNodeEnrollment: (() => fakeEnrollment()) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json']);
    assert.equal(process.exitCode, 1);
    assert.ok(errors.some((line) => line.includes('no local-surface channel known')));
  } finally {
    restore();
    process.exitCode = undefined;
  }
});

test('runLocalSurface caches --channel so a later run without the flag reuses it', async () => {
  const { writes, restore } = withMockedDeps({
    resolveActiveFleetNodeEnrollment: (() => fakeEnrollment()) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json', '--channel', 'local-surface-demo-persona']);
    assert.equal(process.exitCode, 0);

    await runLocalSurface(['/personas/demo.json']);
    assert.equal(process.exitCode, 0);
    assert.equal(writes.length, 2);
    assert.ok(writes[1]!.contents.includes('"local-surface-demo-persona"'));
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
    await runLocalSurface(['/personas/demo.json', '--channel', 'local-surface-demo-persona', '--json']);
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
    })) as never,
    resolveActiveFleetNodeEnrollment: (() => fakeEnrollment()) as never
  });
  try {
    process.exitCode = undefined;
    await runLocalSurface(['/personas/demo.json', '--channel', 'local-surface-demo-persona']);
    assert.ok(errors.some((line) => line.includes('does not mirror')));
  } finally {
    restore();
    process.exitCode = undefined;
  }
});
