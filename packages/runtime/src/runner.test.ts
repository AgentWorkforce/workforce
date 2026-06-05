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

async function writeArgCaptureHarness(
  binDir: string,
  name: string,
  capturePath: string
): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, name),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv: process.argv.slice(2) }, null, 2));`,
      "process.stdout.write('ok\\n');"
    ].join('\n'),
    'utf8'
  );
  await chmod(path.join(binDir, name), 0o755);
}

async function writeFakeBroker(binDir: string, capturePath: string): Promise<void> {
  await mkdir(binDir, { recursive: true });
  await writeFile(
    path.join(binDir, 'agent-relay-broker'),
    [
      '#!/usr/bin/env node',
      "const fs = require('node:fs');",
      'const argv = process.argv.slice(2);',
      `fs.writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({ argv }, null, 2));`,
      'process.stdout.write(JSON.stringify({',
      '  args: [',
      '    "--config",',
      '    "check_for_update_on_startup=false",',
      '    "--config",',
      '    "mcp_servers.agent-relay.command=\\"npx\\"",',
      '    "--config",',
      '    "mcp_servers.agent-relay.args=[\\"-y\\", \\"agent-relay\\", \\"mcp\\"]",',
      '    "--config",',
      '    "mcp_servers.agent-relay.env.RELAY_AGENT_TOKEN=\\"at_live_test\\"",',
      '    "--config",',
      '    "mcp_servers.agent-relay.env.RELAY_SKIP_BOOTSTRAP=\\"1\\""',
      '  ],',
      '  sideEffectFiles: [],',
      '  agentToken: "at_live_test"',
      '}));'
    ].join('\n'),
    'utf8'
  );
  await chmod(path.join(binDir, 'agent-relay-broker'), 0o755);
}

test('cloud default codex harness injects agent-relay MCP args from broker helper', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'workforce-runtime-'));
  try {
    const binDir = path.join(tempDir, 'bin');
    const workspaceRoot = path.join(tempDir, 'workspace');
    const capturePath = path.join(tempDir, 'codex-argv.json');
    const brokerCapturePath = path.join(tempDir, 'broker-argv.json');
    await mkdir(workspaceRoot, { recursive: true });
    await writeArgCaptureHarness(binDir, 'codex', capturePath);
    await writeFakeBroker(binDir, brokerCapturePath);

    const defaults = createCloudRuntimeDefaults({
      persona: {
        ...persona,
        id: 'autonomous-actor',
        harness: 'codex',
        model: 'openai/gpt-5',
        systemPrompt: 'coordinate with the team',
        harnessSettings: {
          reasoning: 'medium',
          dangerouslyBypassApprovalsAndSandbox: true,
          timeoutSeconds: 5
        }
      },
      agent: runtimeAgent,
      deployment: runtimeDeployment,
      workspaceId: 'ws-test',
      log: () => {},
      env: {
        PATH: `${binDir}${path.delimiter}${process.env.PATH ?? ''}`,
        WORKFORCE_SANDBOX_ROOT: workspaceRoot,
        RELAY_API_KEY: 'rk_live_test',
        RELAY_AGENT_NAME: 'codex-1',
        RELAY_BASE_URL: 'https://relay.example.test',
        RELAY_DEFAULT_WORKSPACE: 'ws-relay',
        RELAY_WORKSPACES_JSON: '{"workspaces":[{"id":"ws-relay"}]}'
      }
    });

    const result = await defaults.harnessRunner({ prompt: 'do the work' });
    assert.equal(result.exitCode, 0);

    const captured = JSON.parse(await readFile(capturePath, 'utf8')) as { argv: string[] };
    assert.deepEqual(captured.argv.slice(0, 9), [
      'exec',
      '--config',
      'check_for_update_on_startup=false',
      '--config',
      'mcp_servers.agent-relay.command="npx"',
      '--config',
      'mcp_servers.agent-relay.args=["-y", "agent-relay", "mcp"]',
      '--config',
      'mcp_servers.agent-relay.env.RELAY_AGENT_TOKEN="at_live_test"'
    ]);
    assert.equal(captured.argv[9], '--config');
    assert.equal(captured.argv[10], 'mcp_servers.agent-relay.env.RELAY_SKIP_BOOTSTRAP="1"');
    assert.equal(captured.argv[11], '-m');
    assert.equal(captured.argv[12], 'gpt-5');
    assert.ok(captured.argv.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(captured.argv.includes('--skip-git-repo-check'));

    const brokerCaptured = JSON.parse(await readFile(brokerCapturePath, 'utf8')) as {
      argv: string[];
    };
    assert.deepEqual(brokerCaptured.argv.slice(0, 11), [
      'mcp-args',
      '--cli',
      'codex',
      '--agent-name',
      'codex-1',
      '--api-key',
      'rk_live_test',
      '--base-url',
      'https://relay.example.test',
      '--register',
      '--cwd'
    ]);
    assert.equal(brokerCaptured.argv[11], workspaceRoot);
    const existingArgsIdx = brokerCaptured.argv.indexOf('--existing-args');
    assert.notEqual(existingArgsIdx, -1);
    assert.deepEqual(
      JSON.parse(brokerCaptured.argv[existingArgsIdx + 1]),
      captured.argv.slice(11)
    );
    assert.equal(
      brokerCaptured.argv[brokerCaptured.argv.indexOf('--workspaces-json') + 1],
      '{"workspaces":[{"id":"ws-relay"}]}'
    );
    assert.equal(
      brokerCaptured.argv[brokerCaptured.argv.indexOf('--default-workspace') + 1],
      'ws-relay'
    );
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

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
