import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDeploymentLogEntries,
  formatDeploymentsTable,
  parseDeploymentAgents,
  parseDeploymentListArgs,
  parseDeploymentLogsArgs,
  runDeploymentList,
  tailLogEntriesFromNewestFiles
} from './list-command.js';

test('parseDeploymentListArgs accepts deployment list filters', () => {
  assert.deepEqual(
    parseDeploymentListArgs([
      '--workspace',
      'ws-1',
      '--status=active',
      '--persona',
      'weekly-digest',
      '--cloud-url',
      'https://cloud.example.test',
      '--json',
      '--no-prompt'
    ]),
    {
      workspace: 'ws-1',
      status: 'active',
      persona: 'weekly-digest',
      cloudUrl: 'https://cloud.example.test',
      json: true,
      noPrompt: true
    }
  );
});

test('formatDeploymentsTable renders agent rows', () => {
  const out = formatDeploymentsTable([
    {
      agentId: 'b2f111111111111111111111e8c2',
      personaId: '7133e815-8c84-5d05-a08b-e434006b11ac',
      personaSlug: 'weekly-digest',
      deployedName: 'Weekly Digest',
      status: 'active',
      createdAt: '2026-05-13T09:11:00.000Z',
      updatedAt: '2026-07-17T08:45:00.000Z',
      lastUsedAt: null,
      lastRunStatus: 'succeeded',
      lastError: null,
      integrationWatchHealth: {
        status: 'healthy',
        reason: null,
        lastSuccessfulDeliveryAt: '2026-07-17T08:44:00.000Z',
        lastDeliveryAt: '2026-07-17T08:44:00.000Z',
        lastFailedDeliveryAt: null,
        pendingDeliveryCount: 0,
        recentFailedDeliveryCount: 0,
        recentWorkspaceDispatchFailureCount: 0,
        latestWorkspaceDispatchFailureAt: null
      },
      scheduleIds: ['sched-1'],
      deployedByUserId: 'user-1'
    }
  ]);
  assert.match(out, /name\s+deployment\s+lastRun\s+watch\s+deployed\s+lastUsed\s+agentId/);
  assert.match(out, /b2f1\.\.\.e8c2/);
  assert.match(out, /Weekly Digest/);
  assert.doesNotMatch(out, /7133e815/);
  assert.match(out, /2026-07-17 08:45 UTC/);
  assert.doesNotMatch(out, /2026-05-13 09:11 UTC/);
  assert.match(out, /Weekly Digest\s+active\s+succeeded\s+healthy/);
  assert.doesNotMatch(out, /Errors:/);
});

test('formatDeploymentsTable falls back to createdAt when updatedAt is absent', () => {
  const out = formatDeploymentsTable([
    {
      agentId: 'agent-1',
      personaId: 'persona-1',
      personaSlug: 'demo',
      deployedName: 'Demo',
      status: 'active',
      createdAt: '2026-05-13T09:11:00.000Z',
      lastUsedAt: null,
      scheduleIds: [],
      deployedByUserId: 'user-1'
    }
  ]);
  assert.match(out, /2026-05-13 09:11 UTC/);
});

test('parseDeploymentAgents preserves run failures and integration watch health', () => {
  const e2bigError =
    '/home/daytona/.daytona/sessions/tick-1/cmd.sh:\r\n\u001b[31mline 3: /usr/bin/timeout: Argument list too long\u001b[0m';
  const agents = parseDeploymentAgents({
    agents: [
      {
        agentId: 'agent-e2big',
        personaId: 'hoopsheet-maintainability',
        deployedName: 'hoopsheet-maintainability',
        status: 'active',
        createdAt: '2026-07-17T12:55:00.000Z',
        lastUsedAt: null,
        lastRunStatus: 'failed',
        lastError: e2bigError,
        scheduleIds: [],
        deployedByUserId: 'user-1',
        integrationWatchHealth: {
          status: 'unhealthy',
          reason: 'delivery_failures',
          lastSuccessfulDeliveryAt: null,
          lastDeliveryAt: '2026-07-17T12:56:18.851Z',
          lastFailedDeliveryAt: '2026-07-17T13:15:18.163Z',
          pendingDeliveryCount: 0,
          recentFailedDeliveryCount: 1,
          recentWorkspaceDispatchFailureCount: 0,
          latestWorkspaceDispatchFailureAt: null
        }
      },
      {
        agentId: 'agent-xai',
        personaId: 'x-reply-radar',
        deployedName: 'x-reply-radar',
        status: 'active',
        createdAt: '2026-07-17T07:54:00.000Z',
        lastUsedAt: null,
        lastRunStatus: 'failed',
        lastError: 'Your xAI (Grok) credentials have expired and could not be refreshed automatically.',
        scheduleIds: [],
        deployedByUserId: 'user-2',
        integrationWatchHealth: {
          status: 'unknown',
          reason: 'awaiting_first_successful_delivery',
          lastSuccessfulDeliveryAt: null,
          lastDeliveryAt: null,
          lastFailedDeliveryAt: null,
          pendingDeliveryCount: 0,
          recentFailedDeliveryCount: 0,
          recentWorkspaceDispatchFailureCount: 0,
          latestWorkspaceDispatchFailureAt: null
        }
      }
    ]
  });

  assert.equal(agents[0]?.lastRunStatus, 'failed');
  assert.equal(agents[0]?.lastError, e2bigError);
  assert.deepEqual(agents[0]?.integrationWatchHealth, {
    status: 'unhealthy',
    reason: 'delivery_failures',
    lastSuccessfulDeliveryAt: null,
    lastDeliveryAt: '2026-07-17T12:56:18.851Z',
    lastFailedDeliveryAt: '2026-07-17T13:15:18.163Z',
    pendingDeliveryCount: 0,
    recentFailedDeliveryCount: 1,
    recentWorkspaceDispatchFailureCount: 0,
    latestWorkspaceDispatchFailureAt: null
  });
  assert.equal(agents[1]?.lastRunStatus, 'failed');
  assert.equal(
    agents[1]?.lastError,
    'Your xAI (Grok) credentials have expired and could not be refreshed automatically.'
  );
  assert.deepEqual(agents[1]?.integrationWatchHealth, {
    status: 'unknown',
    reason: 'awaiting_first_successful_delivery',
    lastSuccessfulDeliveryAt: null,
    lastDeliveryAt: null,
    lastFailedDeliveryAt: null,
    pendingDeliveryCount: 0,
    recentFailedDeliveryCount: 0,
    recentWorkspaceDispatchFailureCount: 0,
    latestWorkspaceDispatchFailureAt: null
  });
});

test('runDeploymentList --json preserves raw multiline and control-bearing failure fields', async () => {
  const rawError =
    '/home/daytona/.daytona/sessions/tick-1/cmd.sh:\r\n\u001b[31mline 3: /usr/bin/timeout: Argument list too long\u001b[0m';
  const originalFetch = globalThis.fetch;
  const originalExit = process.exit;
  const originalStdout = process.stdout.write;
  const originalStderr = process.stderr.write;
  const originalToken = process.env.WORKFORCE_WORKSPACE_TOKEN;
  let stdout = '';
  let stderr = '';
  const exits: number[] = [];

  process.env.WORKFORCE_WORKSPACE_TOKEN = 'test-token';
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        agents: [
          {
            agentId: 'agent-e2big',
            personaId: 'hoopsheet-maintainability',
            deployedName: 'hoopsheet-maintainability',
            status: 'active',
            createdAt: '2026-07-17T12:55:00.000Z',
            lastUsedAt: null,
            lastRunStatus: 'failed',
            lastError: rawError,
            scheduleIds: [],
            deployedByUserId: 'user-1',
            integrationWatchHealth: {
              status: 'unhealthy',
              reason: 'delivery_failures',
              lastSuccessfulDeliveryAt: null,
              lastDeliveryAt: '2026-07-17T12:56:18.851Z',
              lastFailedDeliveryAt: '2026-07-17T13:15:18.163Z',
              pendingDeliveryCount: 0,
              recentFailedDeliveryCount: 1,
              recentWorkspaceDispatchFailureCount: 0,
              latestWorkspaceDispatchFailureAt: null
            }
          }
        ]
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )) as typeof globalThis.fetch;
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    stdout += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    stderr += typeof chunk === 'string' ? chunk : chunk.toString();
    return true;
  }) as typeof process.stderr.write;

  try {
    await runDeploymentList([
      '--workspace',
      'ws-test',
      '--cloud-url',
      'https://cloud.example.test',
      '--json',
      '--no-prompt'
    ]);

    const output = JSON.parse(stdout) as { agents: Array<Record<string, unknown>> };
    assert.deepEqual(exits, [0]);
    assert.equal(stderr, '');
    assert.equal(output.agents[0]?.lastRunStatus, 'failed');
    assert.equal(output.agents[0]?.lastError, rawError);
    assert.deepEqual(output.agents[0]?.integrationWatchHealth, {
      status: 'unhealthy',
      reason: 'delivery_failures',
      lastSuccessfulDeliveryAt: null,
      lastDeliveryAt: '2026-07-17T12:56:18.851Z',
      lastFailedDeliveryAt: '2026-07-17T13:15:18.163Z',
      pendingDeliveryCount: 0,
      recentFailedDeliveryCount: 1,
      recentWorkspaceDispatchFailureCount: 0,
      latestWorkspaceDispatchFailureAt: null
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.exit = originalExit;
    process.stdout.write = originalStdout;
    process.stderr.write = originalStderr;
    if (originalToken === undefined) delete process.env.WORKFORCE_WORKSPACE_TOKEN;
    else process.env.WORKFORCE_WORKSPACE_TOKEN = originalToken;
  }
});

test('formatDeploymentsTable makes distinct active deployment failures unmistakable', () => {
  const e2bigMultilineError =
    '/home/daytona/.daytona/sessions/tick-1/cmd.sh:\r\nline 3: /usr/bin/timeout: Argument list too long';
  const agents = parseDeploymentAgents({
    agents: [
      {
        agentId: 'agent-e2big',
        personaId: 'hoopsheet-maintainability',
        deployedName: 'hoopsheet-maintainability',
        status: 'active',
        createdAt: '2026-07-17T12:55:00.000Z',
        lastUsedAt: null,
        lastRunStatus: 'failed',
        lastError: e2bigMultilineError,
        scheduleIds: [],
        deployedByUserId: 'user-1',
        integrationWatchHealth: {
          status: 'unhealthy',
          reason: 'delivery_failures',
          lastSuccessfulDeliveryAt: null,
          lastDeliveryAt: '2026-07-17T12:56:18.851Z',
          lastFailedDeliveryAt: '2026-07-17T13:15:18.163Z',
          pendingDeliveryCount: 0,
          recentFailedDeliveryCount: 1,
          recentWorkspaceDispatchFailureCount: 0,
          latestWorkspaceDispatchFailureAt: null
        }
      },
      {
        agentId: 'agent-xai',
        personaId: 'x-reply-radar',
        deployedName: 'x-reply-radar',
        status: 'active',
        createdAt: '2026-07-17T07:54:00.000Z',
        lastUsedAt: null,
        lastRunStatus: 'failed',
        lastError: 'Your xAI (Grok) credentials have expired and could not be refreshed automatically.',
        scheduleIds: [],
        deployedByUserId: 'user-2',
        integrationWatchHealth: {
          status: 'unknown',
          reason: 'awaiting_first_successful_delivery',
          lastSuccessfulDeliveryAt: null,
          lastDeliveryAt: null,
          lastFailedDeliveryAt: null,
          pendingDeliveryCount: 0,
          recentFailedDeliveryCount: 0,
          recentWorkspaceDispatchFailureCount: 0,
          latestWorkspaceDispatchFailureAt: null
        }
      }
    ]
  });

  const out = formatDeploymentsTable(agents);
  assert.match(out, /name\s+deployment\s+lastRun\s+watch\s+deployed\s+lastUsed\s+agentId/);
  assert.match(out, /hoopsheet-maintainability\s+active\s+failed\s+unhealthy/);
  assert.match(out, /x-reply-radar\s+active\s+failed\s+unknown/);
  assert.match(out, /Errors:/);
  assert.match(
    out,
    /hoopsheet-maintainability: \/home\/daytona\/.* line 3: \/usr\/bin\/timeout: Argument list too long/
  );
  assert.match(out, /x-reply-radar: Your xAI \(Grok\) credentials have expired/);
  assert.doesNotMatch(out, /\r/);
});

test('formatDeploymentsTable collapses and bounds multiline error details', () => {
  const longMultilineError = `first line\r\nsecond line ${'x'.repeat(300)}`;
  const out = formatDeploymentsTable([
    {
      agentId: 'agent-long-error',
      personaId: 'long-error',
      personaSlug: 'long-error',
      deployedName: 'long-error',
      status: 'active',
      createdAt: '2026-07-17T12:55:00.000Z',
      lastUsedAt: null,
      lastRunStatus: 'failed',
      lastError: longMultilineError,
      scheduleIds: [],
      deployedByUserId: 'user-1'
    }
  ]);

  assert.match(out, /long-error: first line second line x+/);
  assert.doesNotMatch(out, /\r/);
  assert.doesNotMatch(out, new RegExp(`x{300}`));
  assert.match(out, /\.\.\./);
});

test('parseDeploymentLogsArgs accepts selector and log flags', () => {
  assert.deepEqual(
    parseDeploymentLogsArgs([
      'Weekly Digest',
      '--workspace=ws-1',
      '--path',
      '/_logs/ws-1/2026-05-19.jsonl',
      '--tail',
      '25',
      '--cloud-url',
      'https://cloud.example.test',
      '--json',
      '--no-prompt'
    ]),
    {
      selector: 'Weekly Digest',
      workspace: 'ws-1',
      path: '/_logs/ws-1/2026-05-19.jsonl',
      tail: 25,
      cloudUrl: 'https://cloud.example.test',
      json: true,
      noPrompt: true
    }
  );
});

test('formatDeploymentLogEntries renders structured log rows', () => {
  const out = formatDeploymentLogEntries([
    {
      ts: '2026-05-19T13:00:00.000Z',
      level: 'info',
      agentId: 'agent-1',
      msg: 'handled event'
    }
  ]);
  assert.match(out, /2026-05-19T13:00:00.000Z\s+INFO\s+agent-1\s+handled event/);
});

test('tailLogEntriesFromNewestFiles keeps the newest entries across files', () => {
  const entries = tailLogEntriesFromNewestFiles(
    [
      [
        { ts: '2026-05-19T13:00:00.000Z', msg: 'newer-a' },
        { ts: '2026-05-19T14:00:00.000Z', msg: 'newer-b' },
        { ts: '2026-05-19T15:00:00.000Z', msg: 'newer-c' }
      ],
      [
        { ts: '2026-05-18T10:00:00.000Z', msg: 'older-a' },
        { ts: '2026-05-18T11:00:00.000Z', msg: 'older-b' }
      ]
    ],
    3
  );

  assert.deepEqual(entries.map((entry) => entry.msg), ['newer-a', 'newer-b', 'newer-c']);
});
