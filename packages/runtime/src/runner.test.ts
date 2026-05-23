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

test('startRunner supplies cloud github and harness defaults when generated runner passes none', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-runtime-cloud-defaults-'));
  const binDir = path.join(dir, 'bin');
  const workspaceRoot = path.join(dir, 'workspace');
  const usageRequests: unknown[] = [];
  const usageServer = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      usageRequests.push({
        authorization: req.headers.authorization,
        body: JSON.parse(body)
      });
      res.writeHead(204).end();
    });
  });
  await new Promise<void>((resolve) => usageServer.listen(0, '127.0.0.1', resolve));
  const usageAddress = usageServer.address();
  assert.ok(usageAddress && typeof usageAddress === 'object');
  const usageUrl = `http://127.0.0.1:${(usageAddress as AddressInfo).port}/usage`;

  const previousEnv = snapshotEnv([
    'PATH',
    'WORKFORCE_SANDBOX_ROOT',
    'RELAYFILE_MOUNT_ROOT',
    'WORKFORCE_USAGE_URL',
    'WORKFORCE_DEPLOYMENT_TOKEN',
    'WORKFORCE_RELAYFILE_WRITEBACK_TIMEOUT_MS'
  ]);
  try {
    await writeFakeHarness(binDir, 'claude', [
      'Generated essay from fake harness',
      'WORKFORCE_USAGE_JSON={"inputTokens":11,"outputTokens":7,"totalTokens":18,"model":"fake-model"}'
    ].join('\n'));
    process.env.PATH = `${binDir}${path.delimiter}${process.env.PATH ?? ''}`;
    process.env.WORKFORCE_SANDBOX_ROOT = workspaceRoot;
    process.env.RELAYFILE_MOUNT_ROOT = workspaceRoot;
    process.env.WORKFORCE_USAGE_URL = usageUrl;
    process.env.WORKFORCE_DEPLOYMENT_TOKEN = 'deployment-token';
    process.env.WORKFORCE_RELAYFILE_WRITEBACK_TIMEOUT_MS = '0';

    let harnessOutput = '';
    let pullRequestUrl = '';
    await startRunner({
      persona: {
        ...persona,
        integrations: { github: { triggers: [{ on: 'pull_request.opened' }] } }
      },
      agent: runtimeAgent,
      deployment: runtimeDeployment,
      workspaceId: 'ws-test',
      handler: handler(async (ctx) => {
        assert.ok(ctx.github, 'github client should be attached from persona integrations');
        const result = await ctx.harness.run({ cwd: '/workspace', prompt: 'draft the essay' });
        harnessOutput = result.output;
        const pr = await ctx.github.createPullRequest({
          owner: 'AgentWorkforce',
          repo: 'proactive-agents',
          title: 'Essay: Launch notes',
          body: 'Drafted by test',
          head: 'essay/launch-notes',
          base: 'main',
          files: { 'output/launch-notes.md': result.output }
        });
        pullRequestUrl = pr.url;
      }),
      subsystems: {
        log: () => {
          /* keep test output quiet */
        }
      },
      envelopes: streamOf([
        { id: 'e1', workspace: 'ws-test', type: 'cron.tick', occurredAt: 'x', name: 'tick' }
      ])
    });

    assert.equal(harnessOutput, 'Generated essay from fake harness');
    assert.match(pullRequestUrl, /^\/github\/repos\/AgentWorkforce\/proactive-agents\/pulls\//);
    const pullDrafts = await readdir(
      path.join(workspaceRoot, 'github/repos/AgentWorkforce/proactive-agents/pulls')
    );
    assert.equal(pullDrafts.length, 1);
    const pullDraft = JSON.parse(
      await readFile(
        path.join(workspaceRoot, 'github/repos/AgentWorkforce/proactive-agents/pulls', pullDrafts[0]),
        'utf8'
      )
    ) as { title?: string; files?: Record<string, string> };
    assert.equal(pullDraft.title, 'Essay: Launch notes');
    assert.equal(pullDraft.files?.['output/launch-notes.md'], 'Generated essay from fake harness');
    assert.equal(usageRequests.length, 1);
    const usageRequest = usageRequests[0] as {
      authorization?: string;
      body?: {
        durationMs?: number;
        usage?: { raw?: unknown };
        [key: string]: unknown;
      };
    };
    assert.equal(usageRequest.authorization, 'Bearer deployment-token');
    assert.equal(typeof usageRequest.body?.durationMs, 'number');
    assert.deepEqual(usageRequest.body, {
      workspaceId: 'ws-test',
      deploymentId: 'deployment_456',
      agentId: 'agent_123',
      personaId: 'demo',
      harness: 'claude',
      model: 'fake-model',
      durationMs: usageRequest.body?.durationMs,
      exitCode: 0,
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
        model: 'fake-model',
        raw: {
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
          model: 'fake-model'
        }
      }
    });
  } finally {
    restoreEnv(previousEnv);
    await new Promise<void>((resolve) => usageServer.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('createCloudRuntimeDefaults builds slack integrations and workflow when workspace cloud env is present', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-runtime-cloud-workflow-'));
  await mkdir(path.join(dir, 'workflows'), { recursive: true });
  await writeFile(
    path.join(dir, 'workflows/cloud-small-issue-codex.ts'),
    'console.log("workflow body");\n',
    'utf8'
  );
  const requests: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders; body?: unknown }> = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      body += chunk;
    });
    req.on('end', () => {
      requests.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        body: body ? JSON.parse(body) : undefined
      });
      if (req.method === 'POST' && req.url === '/api/v1/workflows/run') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ runId: 'run-123', status: 'pending' }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/v1/workflows/runs/run-123') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'success', output: { prUrl: 'https://example.test/pr/1' } }));
        return;
      }
      res.writeHead(404).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  try {
    const defaults = createCloudRuntimeDefaults({
      persona: {
        ...persona,
        integrations: {
          slack: { triggers: [{ on: 'message' }] },
          linear: { triggers: [{ on: 'Issue' }] },
          notion: { triggers: [{ on: 'page.created' }] },
          jira: { triggers: [{ on: 'issue.created' }] }
        }
      },
      agent: runtimeAgent,
      deployment: runtimeDeployment,
      workspaceId: 'ws-test',
      log: () => {
        /* keep test output quiet */
      },
      env: {
        WORKFORCE_SANDBOX_ROOT: dir,
        RELAYFILE_MOUNT_ROOT: dir,
        WORKFORCE_WORKSPACE_TOKEN: 'workspace-token',
        WORKFORCE_CLOUD_BASE_URL: `http://127.0.0.1:${address.port}`,
        WORKFORCE_RELAYFILE_WRITEBACK_TIMEOUT_MS: '0'
      }
    });

    assert.ok(defaults.integrations?.slack, 'slack client should be attached');
    assert.ok(defaults.integrations?.linear, 'linear client should be attached');
    assert.ok(defaults.integrations?.notion, 'notion client should be attached');
    assert.ok(defaults.integrations?.jira, 'jira client should be attached');
    assert.ok(defaults.workflow, 'workflow context should be attached');

    const handle = await defaults.workflow.run('cloud-small-issue-codex', { issue: 1028 });
    assert.equal(handle.runId, 'run-123');
    const status = await defaults.workflow.status('run-123');
    assert.deepEqual(status, { status: 'success', output: { prUrl: 'https://example.test/pr/1' } });

    const post = requests.find((request) => request.method === 'POST');
    assert.equal(post?.headers.authorization, 'Bearer workspace-token');
    assert.equal(post?.headers['x-workspace-workflow-invocation'], 'true');
    assert.deepEqual(post?.body, {
      workflow: 'console.log("workflow body");\n',
      fileType: 'ts',
      sourceFileType: 'workflow',
      runtime: { id: 'daytona' },
      metadata: {
        invocationSlug: 'cloud-small-issue-codex',
        invocationArgs: JSON.stringify({ issue: 1028 })
      }
    });
    const get = requests.find((request) => request.method === 'GET');
    assert.equal(get?.headers.authorization, 'Bearer workspace-token');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  }
});

test('createCloudRuntimeDefaults omits token-backed slack and workflow when workspace cloud env is absent', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-runtime-cloud-missing-token-'));
  try {
    const defaults = createCloudRuntimeDefaults({
      persona: {
        ...persona,
        integrations: {
          slack: { triggers: [{ on: 'message' }] },
          jira: { triggers: [{ on: 'issue.created' }] }
        }
      },
      agent: runtimeAgent,
      deployment: runtimeDeployment,
      workspaceId: 'ws-test',
      log: () => {
        /* keep test output quiet */
      },
      env: {
        WORKFORCE_SANDBOX_ROOT: dir,
        RELAYFILE_MOUNT_ROOT: dir,
        WORKFORCE_RELAYFILE_WRITEBACK_TIMEOUT_MS: '0'
      }
    });

    assert.equal(defaults.integrations, undefined);
    assert.equal(defaults.workflow, undefined);

    const ctx = buildCtx({
      persona,
      agent: runtimeAgent,
      deployment: runtimeDeployment,
      workspaceId: 'ws-test',
      sandbox: defaults.sandbox,
      files: defaults.files,
      harnessRunner: async () => ({ output: '', exitCode: 0, durationMs: 0 }),
      log: () => {
        /* keep test output quiet */
      }
    });
    await assert.rejects(
      () => ctx.workflow.status('run-123'),
      /ctx.workflow is unavailable: the runner is not connected to the workforce workflows API/
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
