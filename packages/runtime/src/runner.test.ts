import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { startRunner } from './runner.js';
import { handler } from './handler.js';
import type { RawGatewayEnvelope } from './shim.js';
import type { SandboxContext, WorkforceEvent } from './types.js';

const baseRuntime = {
  harness: 'claude' as const,
  model: 'anthropic/claude-3-5-sonnet',
  systemPrompt: 'be helpful',
  harnessSettings: { reasoning: 'medium' as const, timeoutSeconds: 300 }
};

const persona: PersonaSpec = {
  id: 'demo',
  intent: 'documentation',
  tags: ['documentation'],
  description: 'test persona',
  skills: [],
  tiers: { best: baseRuntime, 'best-value': baseRuntime, minimum: baseRuntime },
  cloud: true,
  schedules: [{ name: 'weekly', cron: '0 9 * * 6' }]
};

const stubSandbox: SandboxContext = {
  cwd: '/tmp',
  async exec() {
    return { output: '', exitCode: 0 };
  },
  async readFile() {
    return '';
  },
  async writeFile() {
    /* no-op */
  }
};

async function* streamOf(envelopes: RawGatewayEnvelope[]): AsyncGenerator<RawGatewayEnvelope> {
  for (const env of envelopes) yield env;
}

test('startRunner dispatches a cron envelope to the handler', async () => {
  const received: WorkforceEvent[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  await startRunner({
    persona,
    workspaceId: 'ws-test',
    handler: handler(async (_ctx, event) => {
      received.push(event);
    }),
    subsystems: {
      sandbox: stubSandbox,
      log: (level, message) => logs.push({ level, message })
    },
    envelopes: streamOf([
      {
        id: 'e1',
        workspace: 'ws-test',
        type: 'cron.tick',
        occurredAt: '2026-05-12T09:00:00Z',
        name: 'weekly',
        cron: '0 9 * * 6'
      }
    ])
  });
  assert.equal(received.length, 1);
  assert.equal(received[0].source, 'cron');
  if (received[0].source !== 'cron') return;
  assert.equal(received[0].name, 'weekly');
  assert.ok(logs.find((l) => l.message === 'runner.handler.ok'));
});

test('startRunner logs and continues when the handler throws', async () => {
  const logs: Array<{ level: string; message: string }> = [];
  let invocations = 0;
  await startRunner({
    persona,
    workspaceId: 'ws-test',
    handler: handler(async () => {
      invocations += 1;
      throw new Error('boom');
    }),
    subsystems: {
      sandbox: stubSandbox,
      log: (level, message) => logs.push({ level, message })
    },
    envelopes: streamOf([
      { id: 'e1', workspace: 'ws-test', type: 'cron.tick', occurredAt: 'x' },
      { id: 'e2', workspace: 'ws-test', type: 'cron.tick', occurredAt: 'x' }
    ])
  });
  assert.equal(invocations, 2, 'handler is invoked again after the first failure');
  const errors = logs.filter((l) => l.message === 'runner.handler.error');
  assert.equal(errors.length, 2);
});

test('startRunner skips envelopes that the shim can not translate', async () => {
  const received: WorkforceEvent[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  await startRunner({
    persona,
    workspaceId: 'ws-test',
    handler: handler(async (_ctx, event) => {
      received.push(event);
    }),
    subsystems: {
      sandbox: stubSandbox,
      log: (level, message) => logs.push({ level, message })
    },
    envelopes: streamOf([
      { id: 'e1', workspace: 'ws-test', type: 'mystery.thing', occurredAt: 'x' },
      { id: 'e2', workspace: 'ws-test', type: 'cron.tick', occurredAt: 'x', name: 'tick' }
    ])
  });
  assert.equal(received.length, 1);
  assert.ok(logs.find((l) => l.message === 'runner.envelope.unsupported'));
});

test('buildCtx rejects integrations that collide with core fields', async () => {
  const { buildCtx } = await import('./ctx.js');
  assert.throws(
    () =>
      buildCtx({
        persona,
        workspaceId: 'ws',
        sandbox: stubSandbox,
        harnessRunner: async () => ({ output: '', exitCode: 0, durationMs: 0 }),
        integrations: { harness: { evil: true } }
      }),
    /collides with a core ctx field/
  );
});

test('startRunner throws when workspaceId is missing from both options and env', async () => {
  const previous = process.env.WORKFORCE_WORKSPACE_ID;
  delete process.env.WORKFORCE_WORKSPACE_ID;
  try {
    await assert.rejects(
      () =>
        startRunner({
          persona,
          handler: handler(async () => {}),
          subsystems: { sandbox: stubSandbox },
          envelopes: streamOf([])
        }),
      /workspaceId is required/
    );
  } finally {
    if (previous !== undefined) process.env.WORKFORCE_WORKSPACE_ID = previous;
  }
});
