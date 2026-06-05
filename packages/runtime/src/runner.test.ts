import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { AddressInfo } from 'node:net';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { startRunner } from './runner.js';
import { createCloudRuntimeDefaults } from './cloud-defaults.js';
import { buildCtx } from './ctx.js';
import { handler } from './handler.js';
import type { RawGatewayEnvelope } from './shim.js';
import type {
  SandboxContext,
  WorkforceAgentContext,
  WorkforceDeploymentContext,
  WorkforceEvent
} from './types.js';

const persona: PersonaSpec = {
  id: 'demo',
  intent: 'documentation',
  tags: ['documentation'],
  description: 'test persona',
  skills: [],
  harness: 'claude',
  model: 'anthropic/claude-3-5-sonnet',
  systemPrompt: 'be helpful',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
  cloud: true
};

// Listeners live on the agent now, not the persona. Passed to startRunner as
// `agentSpec` (used for startup logging only).
const agentSpec = {
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

const runtimeAgent: WorkforceAgentContext = {
  id: 'agent_123',
  deployedName: 'docs-demo',
  spawnedByAgentId: null
};

const runtimeDeployment: WorkforceDeploymentContext = {
  id: 'deployment_456',
  triggerKind: 'clock',
  parentDeploymentId: null
};

async function* streamOf(envelopes: RawGatewayEnvelope[]): AsyncGenerator<RawGatewayEnvelope> {
  for (const env of envelopes) yield env;
}

test('startRunner dispatches a cron envelope to the handler', async () => {
  const received: WorkforceEvent[] = [];
  const logs: Array<{ level: string; message: string }> = [];
  await startRunner({
    persona,
    agentSpec,
    agent: runtimeAgent,
    deployment: runtimeDeployment,
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
    agent: runtimeAgent,
    deployment: runtimeDeployment,
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
    agent: runtimeAgent,
    deployment: runtimeDeployment,
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
        agent: runtimeAgent,
        deployment: runtimeDeployment,
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
          agent: runtimeAgent,
          deployment: runtimeDeployment,
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

test('cloud harness runner materializes AGENTS.md for grok personas', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'workforce-grok-cloud-'));
  const binDir = path.join(root, 'bin');
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, 'grok'),
    [
      '#!/usr/bin/env node',
      'const fs = require("node:fs");',
      'const path = require("node:path");',
      'const agents = fs.readFileSync(path.join(process.cwd(), "AGENTS.md"), "utf8");',
      'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), agents }));'
    ].join('\n'),
    'utf8'
  );
  await chmod(path.join(binDir, 'grok'), 0o755);

  const envSnapshot = snapshotEnv(['PATH', 'WORKFORCE_SANDBOX_ROOT']);
  process.env.PATH = `${binDir}${path.delimiter}${envSnapshot.PATH ?? ''}`;
  process.env.WORKFORCE_SANDBOX_ROOT = root;
  try {
    const logs: Array<{ level: string; message: string; details?: unknown }> = [];
    const defaults = createCloudRuntimeDefaults({
      persona: {
        ...persona,
        harness: 'grok',
        model: 'grok-build-0.1',
        systemPrompt: 'Grok system prompt',
        agentsMdContent: 'Grok agents sidecar',
        agentsMdMode: 'overwrite'
      },
      agent: runtimeAgent,
      deployment: runtimeDeployment,
      workspaceId: 'ws-test',
      log: (level, message, details) => logs.push({ level, message, details }),
      env: process.env
    });

    const result = await defaults.harnessRunner({ prompt: 'say hello' });
    assert.equal(result.exitCode, 0);
    const parsed = JSON.parse(result.output) as { args: string[]; agents: string };
    assert.deepEqual(parsed.args, [
      '--no-auto-update',
      '--model',
      'grok-build-0.1',
      '--output-format',
      'plain',
      '--cwd',
      root,
      '--always-approve',
      '--single',
      'Grok system prompt\n\nUser task:\nsay hello'
    ]);
    assert.equal(parsed.agents, 'Grok agents sidecar\n');
    assert.ok(logs.find((l) => l.message === 'harness.sidecar.materialized'));
  } finally {
    restoreEnv(envSnapshot);
    await rm(root, { recursive: true, force: true });
  }
});

async function writeFakeHarness(binDir: string, name: string, stdout: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, name),
    [
      '#!/usr/bin/env node',
      `process.stdout.write(${JSON.stringify(stdout.endsWith('\n') ? stdout : `${stdout}\n`)});`
    ].join('\n'),
    'utf8'
  );
  await chmod(path.join(binDir, name), 0o755);
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const key of keys) out[key] = process.env[key];
  return out;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
}
