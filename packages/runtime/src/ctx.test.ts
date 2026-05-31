import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { buildCtx } from './ctx.js';
import type { MemoryItem, SandboxContext } from './types.js';

const basePersona: PersonaSpec = {
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

function ctxFor(
  persona: PersonaSpec,
  inputValues?: Record<string, string | number | boolean | null | undefined>,
  workspaceId = 'ws-test'
) {
  return buildCtx({
    persona,
    workspaceId,
    sandbox: stubSandbox,
    harnessRunner: async () => ({ output: '', exitCode: 0, durationMs: 0 }),
    agent: {
      id: 'agent_123',
      deployedName: 'docs-demo',
      spawnedByAgentId: 'agent_parent',
      input_values: inputValues
    },
    deployment: {
      id: 'deployment_456',
      triggerKind: 'inbox',
      parentDeploymentId: 'deployment_parent'
    }
  });
}

test('buildCtx resolves agent input values ahead of persona defaults', () => {
  const ctx = ctxFor(
    {
      ...basePersona,
      inputs: {
        TARGET: { default: 'default-target' }
      }
    },
    { TARGET: 'agent-target' }
  );

  assert.deepEqual(ctx.persona.inputs, { TARGET: 'agent-target' });
});

test('buildCtx fills persona input defaults when agent values are absent', () => {
  const ctx = ctxFor({
    ...basePersona,
    inputs: {
      TARGET: { default: 'default-target' }
    }
  });

  assert.deepEqual(ctx.persona.inputs, { TARGET: 'default-target' });
});

test('buildCtx throws the deploy input guidance for required missing inputs', () => {
  assert.throws(
    () =>
      ctxFor({
        ...basePersona,
        inputs: {
          TARGET: { description: 'Required target' }
        }
      }),
    /Required input 'TARGET' has no value \(no deployment override, no spec default\)\. Set it via 'workforce deploy --input <key>=<value>' or by editing the agent record\./
  );
});

test('buildCtx keeps persona input specs alongside resolved values', () => {
  const ctx = ctxFor({
    ...basePersona,
    inputs: {
      TARGET: { description: 'Target package', default: 'default-target' }
    }
  });

  assert.equal(ctx.persona.inputs.TARGET, 'default-target');
  assert.deepEqual(ctx.persona.inputSpecs, {
    TARGET: { description: 'Target package', default: 'default-target' }
  });
});

test('buildCtx exposes agent and deployment metadata', () => {
  const ctx = ctxFor(basePersona);

  assert.deepEqual(ctx.agent, {
    id: 'agent_123',
    deployedName: 'docs-demo',
    spawnedByAgentId: 'agent_parent'
  });
  assert.deepEqual(ctx.deployment, {
    id: 'deployment_456',
    triggerKind: 'inbox',
    parentDeploymentId: 'deployment_parent'
  });
});

test('buildCtx exposes ctx.files as a sandbox file helper', async () => {
  const reads: string[] = [];
  const writes: Array<{ path: string; contents: string }> = [];
  const ctx = buildCtx({
    persona: basePersona,
    workspaceId: 'ws-test',
    sandbox: {
      cwd: '/tmp',
      async exec() {
        return { output: '', exitCode: 0 };
      },
      async readFile(path) {
        reads.push(path);
        return 'page body';
      },
      async writeFile(path, contents) {
        writes.push({ path, contents });
      }
    },
    harnessRunner: async () => ({ output: '', exitCode: 0, durationMs: 0 }),
    agent: {
      id: 'agent_123',
      deployedName: 'docs-demo',
      spawnedByAgentId: null
    },
    deployment: {
      id: 'deployment_456',
      triggerKind: 'inbox',
      parentDeploymentId: null
    }
  });

  assert.equal(await ctx.files.read('/notion/pages/page-1.md'), 'page body');
  await ctx.files.write('/workspace/output/page-1.md', 'essay');
  assert.deepEqual(reads, ['/notion/pages/page-1.md']);
  assert.deepEqual(writes, [{ path: '/workspace/output/page-1.md', contents: 'essay' }]);
});

test('buildCtx exposes typed runtime credentials from sandbox env', async () => {
  await withEnv(
    {
      RELAYFILE_URL: 'https://relayfile.example.test',
      RELAYFILE_TOKEN: 'relayfile-token',
      RELAYFILE_WORKSPACE_ID: 'rw_test',
      CLOUD_API_URL: 'https://cloud.example.test',
      CLOUD_API_ACCESS_TOKEN: 'cloud-api-token'
    },
    async () => {
      const ctx = ctxFor(basePersona);
      const expected = {
        relayfile: {
          url: 'https://relayfile.example.test',
          token: 'relayfile-token',
          workspaceId: 'rw_test'
        },
        cloudApi: {
          url: 'https://cloud.example.test',
          token: 'cloud-api-token'
        }
      };

      assert.deepEqual(ctx.credentials.tryRequire(), expected);
      assert.deepEqual(ctx.credentials.require(), expected);
      assert.deepEqual(ctx.credentials.relayfile, expected.relayfile);
      assert.deepEqual(ctx.credentials.cloudApi, expected.cloudApi);
    }
  );
});

test('ctx.credentials returns null or throws with missing runtime credential keys', async () => {
  await withEnv(
    {
      RELAYFILE_URL: 'https://relayfile.example.test',
      RELAYFILE_TOKEN: undefined,
      RELAYFILE_WORKSPACE_ID: 'rw_test',
      CLOUD_API_URL: 'https://cloud.example.test',
      CLOUD_API_ACCESS_TOKEN: 'cloud-api-token'
    },
    async () => {
      const ctx = ctxFor(basePersona);

      assert.equal(ctx.credentials.tryRequire(), null);
      assert.throws(
        () => ctx.credentials.require(),
        /Runtime credentials are required: missing relayfile\.token/
      );
      assert.throws(
        () => ctx.credentials.relayfile,
        /Runtime credentials are required: missing relayfile\.token/
      );
    }
  );
});

test('ctx.credentials strips trailing slashes from runtime credential URLs', async () => {
  await withEnv(
    {
      RELAYFILE_URL: 'https://relayfile.example.test///',
      RELAYFILE_TOKEN: 'relayfile-token',
      RELAYFILE_WORKSPACE_ID: 'rw_test',
      CLOUD_API_URL: 'https://cloud.example.test/',
      CLOUD_API_ACCESS_TOKEN: 'cloud-api-token'
    },
    async () => {
      const ctx = ctxFor(basePersona);

      assert.equal(ctx.credentials.require().relayfile.url, 'https://relayfile.example.test');
      assert.equal(ctx.credentials.require().cloudApi.url, 'https://cloud.example.test');
    }
  );
});

test('ctx.memory.save posts to the cloud memory endpoint when sandbox env is present', async () => {
  await withEnv(
    {
      WORKFORCE_CLOUD_URL: 'https://cloud.example.test/',
      WORKFORCE_WORKSPACE_ID: 'ws-env',
      WORKFORCE_AGENT_TOKEN: 'agent-token'
    },
    async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      await withFetch(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ id: 'mem_123' });
      }, async () => {
        const ctx = ctxFor({ ...basePersona, memory: { enabled: true, scopes: ['workspace'] } });
        const result = await ctx.memory.save('remember this', {
          scope: 'workspace',
          tags: ['notion'],
          expiresInMs: 2500
        });
        assert.deepEqual(result, { id: 'mem_123' });
      });

      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, 'https://cloud.example.test/api/v1/workspaces/ws-env/memory');
      assert.equal(calls[0].init?.method, 'POST');
      assert.equal((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer agent-token');
      assert.deepEqual(JSON.parse(String(calls[0].init?.body)), {
        scope: 'workspace',
        content: 'remember this',
        tags: ['notion'],
        ttlSeconds: 3
      });
    }
  );
});

test('ctx.memory.recall fetches normalized cloud memory items', async () => {
  await withEnv(
    {
      WORKFORCE_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_AGENT_TOKEN: 'agent-token',
      WORKFORCE_WORKSPACE_ID: undefined,
      RELAY_WORKSPACE_ID: undefined,
      RELAY_DEFAULT_WORKSPACE: undefined
    },
    async () => {
      const calls: string[] = [];
      const item: MemoryItem = {
        id: 'mem_123',
        content: 'old essay context',
        tags: ['essay'],
        scope: 'workspace',
        createdAt: '2026-05-13T10:00:00.000Z'
      };
      await withFetch(async (url) => {
        calls.push(String(url));
        return jsonResponse({ items: [item] });
      }, async () => {
        const ctx = ctxFor({ ...basePersona, memory: true });
        const items = await ctx.memory.recall('essay', { scope: 'workspace', limit: 5 });
        assert.deepEqual(items, [item]);
      });

      const url = new URL(calls[0]);
      assert.equal(url.origin + url.pathname, 'https://cloud.example.test/api/v1/workspaces/ws-test/memory');
      assert.equal(url.searchParams.get('scope'), 'workspace');
      assert.equal(url.searchParams.get('query'), 'essay');
      assert.equal(url.searchParams.get('limit'), '5');
    }
  );
});

test('ctx.memory uses relaycast sandbox env fallbacks for workspace and agent token', async () => {
  await withEnv(
    {
      WORKFORCE_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_WORKSPACE_ID: undefined,
      WORKFORCE_AGENT_TOKEN: undefined,
      RELAY_WORKSPACE_ID: undefined,
      RELAY_AGENT_TOKEN: undefined,
      RELAYFILE_TOKEN: undefined,
      RELAY_DEFAULT_WORKSPACE: 'ws-relay',
      RELAY_AGENT_NAME: 'notion-essay-pr',
      RELAY_AGENT_TOKENS: JSON.stringify({ 'notion-essay-pr': 'agent-token-from-map' })
    },
    async () => {
      const calls: Array<{ url: string; init?: RequestInit }> = [];
      await withFetch(async (url, init) => {
        calls.push({ url: String(url), init });
        return jsonResponse({ id: 'mem_relay' });
      }, async () => {
        const ctx = ctxFor({ ...basePersona, memory: true }, undefined, '');
        assert.deepEqual(await ctx.memory.save('from relay env'), { id: 'mem_relay' });
      });

      assert.equal(calls[0].url, 'https://cloud.example.test/api/v1/workspaces/ws-relay/memory');
      assert.equal((calls[0].init?.headers as Record<string, string>).authorization, 'Bearer agent-token-from-map');
    }
  );
});

test('ctx.memory.recall falls back to [] on network failure', async () => {
  await withEnv(
    {
      WORKFORCE_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_AGENT_TOKEN: 'agent-token'
    },
    async () => {
      await withFetch(async () => {
        throw new Error('offline');
      }, async () => {
        const ctx = ctxFor({ ...basePersona, memory: true });
        assert.deepEqual(await ctx.memory.recall('anything'), []);
      });
    }
  );
});

test('ctx.memory logs a bounded timeout when cloud memory fetch aborts', async () => {
  await withEnv(
    {
      WORKFORCE_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_AGENT_TOKEN: 'agent-token'
    },
    async () => {
      const logs: Array<{ level: string; message: string; attrs?: Record<string, unknown> }> = [];
      await withFetch(async (_url, init) => {
        init?.signal?.dispatchEvent(new Event('abort'));
        const err = new Error('aborted');
        err.name = 'AbortError';
        throw err;
      }, async () => {
        const ctx = buildCtx({
          persona: { ...basePersona, memory: true },
          workspaceId: 'ws-test',
          sandbox: stubSandbox,
          harnessRunner: async () => ({ output: '', exitCode: 0, durationMs: 0 }),
          log: (level, message, attrs) => logs.push({ level, message, attrs }),
          agent: {
            id: 'agent_123',
            deployedName: 'docs-demo',
            spawnedByAgentId: null
          },
          deployment: {
            id: 'deployment_456',
            triggerKind: 'inbox',
            parentDeploymentId: null
          }
        });
        assert.equal(await ctx.memory.save('anything'), undefined);
      });
      assert.equal(logs[0].message, 'memory.save.failed');
      assert.match(String(logs[0].attrs?.error), /timeout after \d+ms/);
    }
  );
});

test('ctx.memory stays a safe no-op when cloud auth is absent', async () => {
  await withEnv(
    {
      WORKFORCE_CLOUD_URL: undefined,
      WORKFORCE_AGENT_TOKEN: undefined,
      RELAY_AGENT_TOKEN: undefined,
      RELAYFILE_TOKEN: undefined,
      RELAY_API_KEY: undefined,
      WORKFORCE_WORKSPACE_TOKEN: undefined,
      RELAY_AGENT_TOKENS: undefined,
      RELAY_AGENT_NAME: undefined
    },
    async () => {
      let fetchCalled = false;
      await withFetch(async () => {
        fetchCalled = true;
        return jsonResponse({});
      }, async () => {
        const ctx = ctxFor({ ...basePersona, memory: true });
        assert.equal(await ctx.memory.save('quiet'), undefined);
        assert.deepEqual(await ctx.memory.recall('quiet'), []);
      });
      assert.equal(fetchCalled, false);
    }
  );
});

test('ctx.memory respects memory.enabled=false', async () => {
  await withEnv(
    {
      WORKFORCE_CLOUD_URL: 'https://cloud.example.test',
      WORKFORCE_AGENT_TOKEN: 'agent-token',
      WORKFORCE_WORKSPACE_ID: 'ws-env'
    },
    async () => {
      let fetchCalled = false;
      await withFetch(async () => {
        fetchCalled = true;
        return jsonResponse({});
      }, async () => {
        const ctx = ctxFor({
          ...basePersona,
          memory: { enabled: false, scopes: ['workspace'] }
        });
        assert.equal(await ctx.memory.save('quiet'), undefined);
        assert.deepEqual(await ctx.memory.recall('quiet'), []);
      });
      assert.equal(fetchCalled, false);
    }
  );
});

async function withEnv(
  values: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(values)) {
    previous[key] = process.env[key];
    const value = values[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function withFetch(
  fetchImpl: typeof fetch,
  fn: () => Promise<void>
): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  try {
    await fn();
  } finally {
    globalThis.fetch = previous;
  }
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init
  });
}
