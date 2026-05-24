import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { createCloudRuntimeDefaults } from './cloud-defaults.js';

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

const deployment = {
  id: 'deployment_123',
  triggerKind: 'inbox' as const,
  parentDeploymentId: null
};

function defaultsFor(overrides: {
  workspaceId?: string;
  agentId?: string;
  env?: NodeJS.ProcessEnv;
} = {}) {
  return createCloudRuntimeDefaults({
    persona,
    agent: {
      id: overrides.agentId ?? 'agent_parent',
      deployedName: 'demo',
      spawnedByAgentId: null
    },
    deployment,
    workspaceId: overrides.workspaceId ?? 'ws_test',
    log: () => {
      /* keep test output quiet */
    },
    env: {
      WORKFORCE_SANDBOX_ROOT: '/tmp',
      ...overrides.env
    }
  });
}

test('createCloudRuntimeDefaults omits team without cloud env or path ids', () => {
  assert.equal(defaultsFor().team, undefined);
  assert.equal(defaultsFor({
    env: {
      WORKFORCE_WORKSPACE_TOKEN: 'token',
      WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
    },
    workspaceId: ''
  }).team, undefined);
  assert.equal(defaultsFor({
    agentId: '',
    env: {
      WORKFORCE_WORKSPACE_TOKEN: 'token',
      WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
    }
  }).team, undefined);
});

test('createCloudRuntimeDefaults attaches team with cloud env and path ids', () => {
  const defaults = defaultsFor({
    env: {
      WORKFORCE_WORKSPACE_TOKEN: 'token',
      WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
    }
  });

  assert.equal(typeof defaults.team?.spawn, 'function');
  assert.equal(typeof defaults.team?.attach, 'function');
});

test('ctx.team.spawn posts documented body and returns seeded handle', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch(async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({
      teamId: 'team_123',
      channel: 'team-team_123',
      sharedMountRoot: '/teams/team_123',
      status: 'starting',
      members: []
    }, { status: 201 });
  }, async () => {
    const defaults = defaultsFor({
      env: {
        WORKFORCE_WORKSPACE_TOKEN: 'workspace-token',
        WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test/'
      }
    });
    const handle = await defaults.team!.spawn({
      task: 'Refactor auth',
      teamPrompt: 'Coordinate through the team board',
      members: [{ name: 'lead', persona: 'relay-orchestrator', role: 'orchestrator' }],
      sharedMount: 'issue-421',
      ttlSeconds: 3600,
      maxMembers: 8
    });

    assert.equal(handle.teamId, 'team_123');
    assert.equal(handle.channel, 'team-team_123');
    assert.equal(handle.sharedMountRoot, '/teams/team_123');
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://cloud.example.test/api/v1/workspaces/ws_test/agents/agent_parent/team');
  assert.equal(calls[0].init?.method, 'POST');
  assert.deepEqual(calls[0].init?.headers, {
    accept: 'application/json',
    'content-type': 'application/json',
    authorization: 'Bearer workspace-token'
  });
  assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
    task: 'Refactor auth',
    teamPrompt: 'Coordinate through the team board',
    members: [{ name: 'lead', persona: 'relay-orchestrator', role: 'orchestrator' }],
    sharedMount: 'issue-421',
    ttlSeconds: 3600,
    maxMembers: 8
  });
});

test('ctx.team.spawn throws when cloud response omits teamId', async () => {
  await withFetch(async () => jsonResponse({}, { status: 201 }), async () => {
    const defaults = defaultsFor({
      env: {
        WORKFORCE_WORKSPACE_TOKEN: 'workspace-token',
        WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
      }
    });

    await assert.rejects(
      () => defaults.team!.spawn({ task: 'Refactor auth', members: [] }),
      /ctx\.team\.spawn\(\): cloud response missing teamId/
    );
  });
});

test('ctx.team.completion polls until succeeded and returns team result', async () => {
  const statuses = [
    { teamId: 'team_123', status: 'running', members: [], results: {}, summary: '' },
    {
      teamId: 'team_123',
      status: 'succeeded',
      members: [{ name: 'impl', status: 'succeeded' }],
      results: { impl: { status: 'succeeded', output: 'done', resultId: 'result_1' } },
      summary: 'all done'
    }
  ];
  await withFetch(async (input, init) => {
    if (String(input).endsWith('/team')) {
      return jsonResponse({ teamId: 'team_123', channel: 'team-team_123', sharedMountRoot: '/teams/team_123' }, { status: 201 });
    }
    assert.equal(init?.method, 'GET');
    return jsonResponse(statuses.shift() ?? statuses[0]);
  }, async () => {
    const defaults = defaultsFor({
      env: {
        WORKFORCE_WORKSPACE_TOKEN: 'workspace-token',
        WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
      }
    });
    const handle = await defaults.team!.spawn({ task: 'Refactor auth', members: [] });

    assert.deepEqual(await handle.completion(), {
      status: 'succeeded',
      members: { impl: { status: 'succeeded', output: 'done', resultId: 'result_1' } },
      summary: 'all done'
    });
  });
});

test('ctx.team.completion maps terminal failure statuses', async () => {
  for (const terminal of ['failed', 'timed_out', 'cancelled'] as const) {
    await withFetch(async (input) => {
      if (String(input).endsWith('/team')) {
        return jsonResponse({ teamId: `team_${terminal}` }, { status: 201 });
      }
      return jsonResponse({
        teamId: `team_${terminal}`,
        status: terminal,
        results: { impl: { status: terminal, output: terminal } },
        summary: terminal
      });
    }, async () => {
      const defaults = defaultsFor({
        env: {
          WORKFORCE_WORKSPACE_TOKEN: 'workspace-token',
          WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
        }
      });
      const handle = await defaults.team!.spawn({ task: terminal, members: [] });

      assert.deepEqual(await handle.completion(), {
        status: terminal,
        members: { impl: { status: terminal, output: terminal } },
        summary: terminal
      });
    });
  }
});

test('ctx.team.attach derives handle fields and confirms status endpoint', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch(async (input, init) => {
    calls.push({ url: String(input), init });
    return jsonResponse({ teamId: 'team_abc', status: 'running', members: [], results: {}, summary: '' });
  }, async () => {
    const defaults = defaultsFor({
      env: {
        WORKFORCE_WORKSPACE_TOKEN: 'workspace-token',
        WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
      }
    });
    const handle = await defaults.team!.attach(' team_abc ');

    assert.equal(handle.teamId, 'team_abc');
    assert.equal(handle.channel, 'team-team_abc');
    assert.equal(handle.sharedMountRoot, '/teams/team_abc');
    assert.deepEqual(await handle.status(), {
      teamId: 'team_abc',
      status: 'running',
      members: [],
      results: {},
      summary: ''
    });
  });

  assert.deepEqual(calls.map((call) => [call.init?.method, call.url]), [
    ['GET', 'https://cloud.example.test/api/v1/workspaces/ws_test/teams/team_abc'],
    ['GET', 'https://cloud.example.test/api/v1/workspaces/ws_test/teams/team_abc']
  ]);
});

test('ctx.team.cancel posts to the cancel endpoint and throws on non-2xx', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  await withFetch(async (input, init) => {
    calls.push({ url: String(input), init });
    if (String(input).endsWith('/cancel')) return new Response(null, { status: 204 });
    return jsonResponse({ teamId: 'team_cancel', status: 'running' });
  }, async () => {
    const defaults = defaultsFor({
      env: {
        WORKFORCE_WORKSPACE_TOKEN: 'workspace-token',
        WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
      }
    });
    const handle = await defaults.team!.attach('team_cancel');

    await handle.cancel();
  });

  assert.deepEqual(calls.map((call) => [call.init?.method, call.url]), [
    ['GET', 'https://cloud.example.test/api/v1/workspaces/ws_test/teams/team_cancel'],
    ['POST', 'https://cloud.example.test/api/v1/workspaces/ws_test/teams/team_cancel/cancel']
  ]);

  await withFetch(async (input) => {
    if (String(input).endsWith('/cancel')) return new Response('nope', { status: 500, statusText: 'Server Error' });
    return jsonResponse({ teamId: 'team_cancel', status: 'running' });
  }, async () => {
    const defaults = defaultsFor({
      env: {
        WORKFORCE_WORKSPACE_TOKEN: 'workspace-token',
        WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
      }
    });
    const handle = await defaults.team!.attach('team_cancel');

    await assert.rejects(() => handle.cancel(), /ctx\.team\.attach\("team_cancel"\)\.cancel\(\): 500 Server Error - nope/);
  });
});

test('ctx.team.completion retries transient status errors within the budget', async () => {
  let statusCalls = 0;
  await withFetch(async (input) => {
    if (String(input).endsWith('/team')) {
      return jsonResponse({ teamId: 'team_retry' }, { status: 201 });
    }
    statusCalls += 1;
    if (statusCalls === 1) return new Response('try again', { status: 503, statusText: 'Unavailable' });
    return jsonResponse({ teamId: 'team_retry', status: 'succeeded', results: {}, summary: 'done' });
  }, async () => {
    const defaults = defaultsFor({
      env: {
        WORKFORCE_WORKSPACE_TOKEN: 'workspace-token',
        WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
      }
    });
    const handle = await defaults.team!.spawn({ task: 'retry', members: [] });

    assert.deepEqual(await handle.completion(), {
      status: 'succeeded',
      members: {},
      summary: 'done'
    });
    assert.equal(statusCalls, 2);
  });
});

test('ctx.team.completion throws once the transient retry budget is exhausted', async () => {
  let statusCalls = 0;
  await withFetch(async (input) => {
    if (String(input).endsWith('/team')) {
      return jsonResponse({ teamId: 'team_exhaust' }, { status: 201 });
    }
    statusCalls += 1;
    return new Response('try again', { status: 503, statusText: 'Unavailable' });
  }, async () => {
    const defaults = defaultsFor({
      env: {
        WORKFORCE_WORKSPACE_TOKEN: 'workspace-token',
        WORKFORCE_CLOUD_BASE_URL: 'https://cloud.example.test'
      }
    });
    const handle = await defaults.team!.spawn({ task: 'exhaust', members: [] });

    // Budget is exhausted after MAX_TRANSIENT_ERRORS retries; the next retryable
    // failure is rethrown verbatim (not converted into the deadline-timeout error).
    await assert.rejects(
      () => handle.completion(),
      /ctx\.team\.attach\("team_exhaust"\)\.status\(\): 503 Unavailable - try again/
    );
    // MAX_TRANSIENT_ERRORS (3) retries that continue, then one more poll that throws.
    assert.equal(statusCalls, 4);
  });
});

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers
    }
  });
}

async function withFetch(
  fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> | Response,
  run: () => Promise<void>
): Promise<void> {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof fetch;
  try {
    await run();
  } finally {
    globalThis.fetch = originalFetch;
  }
}
