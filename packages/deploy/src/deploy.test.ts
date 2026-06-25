import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deploy } from './deploy.js';
import { createBufferedIO } from './io.js';
import { preflightPersona } from './preflight.js';
import type {
  BundleStager,
  CloudAuthRecoveryResolver,
  IntegrationConnectResolver,
  IntegrationOptionsResolver,
  ModeLaunchInput,
  ModeLauncher,
  ProviderConfigKeyResolver,
  WorkspaceAuth
} from './index.js';

function basePersonaJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'demo',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'test persona',
    harness: 'claude',
    model: 'anthropic/claude-3-5-sonnet',
    systemPrompt: 'be helpful',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    cloud: true,
    onEvent: './agent.ts',
    ...overrides
  };
}

// Agent (`agent.ts`) sources. Triggers/schedules live here now, not on the
// persona. extractAgentSpec stubs `@agentworkforce/runtime`, so these compile
// without the runtime being installed in the temp dir.
const SCHEDULE_AGENT_SRC = `import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({
  schedules: [{ name: 'weekly', cron: '0 9 * * 6' }],
  handler: async () => {}
});
`;

const NO_LISTENER_AGENT_SRC = `import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({ handler: async () => {} });
`;

const TEAM_DISPATCHER_AGENT_SRC = `import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({
  launchedBy: 'team-dispatcher',
  handler: async () => {}
});
`;

const INVALID_LAUNCHED_BY_AGENT_SRC = `import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({
  launchedBy: '',
  schedules: [{ name: 'weekly', cron: '0 9 * * 6' }],
  handler: async () => {}
});
`;

const MISSING_HANDLER_AGENT_SRC = `import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({
  schedules: [{ name: 'weekly', cron: '0 9 * * 6' }]
});
`;

function githubAgentSrc(on = 'pull_request.opened'): string {
  return `import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({
  triggers: { github: [{ on: '${on}' }] },
  handler: async () => {}
});
`;
}

const SLACK_TELEGRAM_AGENT_SRC = `import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({
  triggers: {
    slack: [{ on: 'message.created' }],
    telegram: [{ on: 'message.created' }]
  },
  handler: async () => {}
});
`;

async function withTempPersona(
  persona: Record<string, unknown>,
  agentSource = SCHEDULE_AGENT_SRC
): Promise<{ dir: string; personaPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-deploy-test-'));
  const personaPath = path.join(dir, 'persona.json');
  await writeFile(personaPath, JSON.stringify(persona, null, 2), 'utf8');
  await writeFile(path.join(dir, 'agent.ts'), agentSource, 'utf8');
  return {
    dir,
    personaPath,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

async function withTempPersonaSource(
  source: string,
  extraFiles: Record<string, string> = {}
): Promise<{ dir: string; personaPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-deploy-source-test-'));
  const personaPath = path.join(dir, 'persona.ts');
  await writeFile(personaPath, source, 'utf8');
  await writeFile(path.join(dir, 'agent.ts'), SCHEDULE_AGENT_SRC, 'utf8');
  await Promise.all(
    Object.entries(extraFiles).map(async ([name, content]) => {
      const target = path.join(dir, name);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, 'utf8');
    })
  );
  return {
    dir,
    personaPath,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

async function withWorkspaceEnv<T>(
  env: { workspace?: string; token?: string },
  fn: () => Promise<T>
): Promise<T> {
  const previousWorkspace = process.env.WORKFORCE_WORKSPACE_ID;
  const previousToken = process.env.WORKFORCE_WORKSPACE_TOKEN;
  if (env.workspace === undefined) {
    delete process.env.WORKFORCE_WORKSPACE_ID;
  } else {
    process.env.WORKFORCE_WORKSPACE_ID = env.workspace;
  }
  if (env.token === undefined) {
    delete process.env.WORKFORCE_WORKSPACE_TOKEN;
  } else {
    process.env.WORKFORCE_WORKSPACE_TOKEN = env.token;
  }

  try {
    return await fn();
  } finally {
    if (previousWorkspace === undefined) {
      delete process.env.WORKFORCE_WORKSPACE_ID;
    } else {
      process.env.WORKFORCE_WORKSPACE_ID = previousWorkspace;
    }
    if (previousToken === undefined) {
      delete process.env.WORKFORCE_WORKSPACE_TOKEN;
    } else {
      process.env.WORKFORCE_WORKSPACE_TOKEN = previousToken;
    }
  }
}

async function withProcessEnv<T>(
  env: Record<string, string | undefined>,
  fn: () => Promise<T>
): Promise<T> {
  const previous = new Map<string, string | undefined>();
  for (const key of Object.keys(env)) {
    previous.set(key, process.env[key]);
    const next = env[key];
    if (next === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = next;
    }
  }

  try {
    return await fn();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

async function withCloudSessionEnv<T>(fn: () => Promise<T>): Promise<T> {
  const previous = {
    CLOUD_API_URL: process.env.CLOUD_API_URL,
    CLOUD_API_ACCESS_TOKEN: process.env.CLOUD_API_ACCESS_TOKEN,
    CLOUD_API_REFRESH_TOKEN: process.env.CLOUD_API_REFRESH_TOKEN,
    CLOUD_API_ACCESS_TOKEN_EXPIRES_AT: process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT
  };
  process.env.CLOUD_API_URL = 'https://cloud.example.test';
  process.env.CLOUD_API_ACCESS_TOKEN = 'cloud-access';
  process.env.CLOUD_API_REFRESH_TOKEN = 'cloud-refresh';
  process.env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT = '2999-01-01T00:00:00.000Z';
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key as keyof typeof previous];
      } else {
        process.env[key as keyof typeof previous] = value;
      }
    }
  }
}

async function withAgentRelayHome<T>(fn: () => Promise<T>): Promise<T> {
  const previous = process.env.AGENT_RELAY_HOME;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-agent-relay-home-'));
  process.env.AGENT_RELAY_HOME = dir;
  try {
    return await fn();
  } finally {
    if (previous === undefined) {
      delete process.env.AGENT_RELAY_HOME;
    } else {
      process.env.AGENT_RELAY_HOME = previous;
    }
    await rm(dir, { recursive: true, force: true });
  }
}

function successfulBundleStager(): BundleStager {
  return {
    async stage(input) {
      await mkdir(input.outDir, { recursive: true });
      const runner = path.join(input.outDir, 'runner.mjs');
      const bundle = path.join(input.outDir, 'agent.bundle.mjs');
      const personaCopy = path.join(input.outDir, 'persona.json');
      const pkg = path.join(input.outDir, 'package.json');
      await Promise.all([
        writeFile(runner, '', 'utf8'),
        writeFile(bundle, '', 'utf8'),
        writeFile(personaCopy, '{}', 'utf8'),
        writeFile(pkg, '{}', 'utf8')
      ]);
      return {
        runnerPath: runner,
        bundlePath: bundle,
        personaCopyPath: personaCopy,
        packageJsonPath: pkg,
        sizeBytes: 1
      };
    }
  };
}

function successfulDevLauncher(onLaunch?: () => void): ModeLauncher {
  return {
    async launch() {
      onLaunch?.();
      return {
        id: 'pid-1',
        async stop() {
          /* no-op */
        },
        done: Promise.resolve({ code: 0 })
      };
    }
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

test('preflightPersona accepts a valid deploy-shaped persona', async () => {
  const { personaPath, cleanup } = await withTempPersona(basePersonaJson());
  try {
    const pre = await preflightPersona(personaPath);
    assert.equal(pre.persona.id, 'demo');
    assert.deepEqual(pre.schedules, ['weekly']);
    assert.deepEqual(pre.integrations, []);
    assert.equal(pre.warnings.length, 0);
  } finally {
    await cleanup();
  }
});

test('preflightPersona accepts authored persona.ts and preserves sibling import.meta.url reads', async () => {
  const { personaPath, cleanup } = await withTempPersonaSource(
    `import { description } from './helpers/description';
import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'typed-demo',
  intent: 'documentation',
  tags: ['documentation'],
  description,
  cloud: true,
  onEvent: './agent.ts',
  harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
});
`,
    {
      'helpers/description.ts': `import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const description = readFileSync(
  fileURLToPath(new URL('./description.txt', import.meta.url)),
  'utf8'
).trim();
`,
      'helpers/description.txt': 'Compiled beside the helper file.\n'
    }
  );
  try {
    const pre = await preflightPersona(personaPath);
    assert.equal(pre.persona.id, 'typed-demo');
    assert.equal(pre.persona.description, 'Compiled beside the helper file.');
    assert.equal(pre.personaPath, personaPath);
    assert.deepEqual(pre.schedules, ['weekly']);
  } finally {
    await cleanup();
  }
});

test('preflightPersona refuses when cloud is not true', async () => {
  const { personaPath, cleanup } = await withTempPersona(basePersonaJson({ cloud: false }));
  try {
    await assert.rejects(preflightPersona(personaPath), /not opted into deploy/);
  } finally {
    await cleanup();
  }
});

test('preflightPersona accepts a cloud persona that opts into memory facets', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ memory: { trajectories: true, aiMemory: true } })
  );
  try {
    const pre = await preflightPersona(personaPath);
    assert.deepEqual(pre.persona.memory, { trajectories: true, aiMemory: true });
  } finally {
    await cleanup();
  }
});

test('preflightPersona refuses when the agent declares no listeners', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: undefined }),
    NO_LISTENER_AGENT_SRC
  );
  try {
    await assert.rejects(preflightPersona(personaPath), /declares no listeners/);
  } finally {
    await cleanup();
  }
});

test('preflightPersona accepts listener-free agents launched by the team dispatcher', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: undefined }),
    TEAM_DISPATCHER_AGENT_SRC
  );
  try {
    const pre = await preflightPersona(personaPath);
    assert.deepEqual(pre.schedules, []);
    assert.equal(pre.agent.launchedBy, 'team-dispatcher');
  } finally {
    await cleanup();
  }
});

test('preflightPersona rejects unsupported launchedBy values even when listeners exist', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: undefined }),
    INVALID_LAUNCHED_BY_AGENT_SRC
  );
  try {
    await assert.rejects(preflightPersona(personaPath), /launchedBy must be one of: team-dispatcher/);
  } finally {
    await cleanup();
  }
});

test('preflightPersona refuses when defineAgent omits handler', async () => {
  const { personaPath, cleanup } = await withTempPersona(basePersonaJson(), MISSING_HANDLER_AGENT_SRC);
  try {
    await assert.rejects(preflightPersona(personaPath), /must default-export defineAgent/);
  } finally {
    await cleanup();
  }
});

test('preflightPersona refuses when the agent triggers a provider the persona does not connect', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: undefined }),
    githubAgentSrc()
  );
  try {
    await assert.rejects(preflightPersona(personaPath), /does not connect/);
  } finally {
    await cleanup();
  }
});

test('preflightPersona refuses optional integrations enabled by undeclared inputs', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        slack: { optional: true, enabledByInput: 'SLACK_CHANNEL' }
      }
    })
  );
  try {
    await assert.rejects(
      preflightPersona(personaPath),
      /integration "slack" is enabled by input "SLACK_CHANNEL".*persona\.inputs does not declare SLACK_CHANNEL/
    );
  } finally {
    await cleanup();
  }
});

test('preflightPersona refuses when onEvent file is missing', async () => {
  const { personaPath, cleanup } = await withTempPersona(basePersonaJson({ onEvent: './does-not-exist.ts' }));
  try {
    await assert.rejects(preflightPersona(personaPath), /onEvent file not found/);
  } finally {
    await cleanup();
  }
});

test('preflightPersona warns on unknown triggers but does not fail', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: { github: {} } }),
    githubAgentSrc('pull_request.imagined_event')
  );
  try {
    const pre = await preflightPersona(personaPath);
    assert.equal(pre.warnings.length, 1);
    assert.match(pre.warnings[0], /pull_request\.imagined_event/);
  } finally {
    await cleanup();
  }
});

test('deploy --dry-run validates persona and exits before side effects', async () => {
  const { personaPath, cleanup } = await withTempPersona(basePersonaJson());
  const io = createBufferedIO();
  try {
    const result = await deploy({ personaPath, dryRun: true, io });
    assert.equal(result.deploymentId, 'demo');
    assert.deepEqual(result.schedules, ['weekly']);
    assert.ok(io.messages.find((m) => m.message.includes('--dry-run')));
    // No workspace resolution happened.
    assert.ok(!io.messages.find((m) => m.message.startsWith('workspace:')));
  } finally {
    await cleanup();
  }
});

test('deploy --dry-run accepts useSubscription personas in cloud mode', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ useSubscription: true })
  );
  const io = createBufferedIO();
  try {
    const result = await deploy({ personaPath, mode: 'cloud', dryRun: true, io });
    assert.equal(result.deploymentId, 'demo');
    assert.equal(result.mode, 'cloud');
    assert.ok(io.messages.find((m) => m.message.includes('--dry-run')));
    assert.ok(!io.messages.find((m) => m.message.startsWith('workspace:')));
  } finally {
    await cleanup();
  }
});

test('deploy --dry-run rejects useSubscription when cloud mode is not selected', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ useSubscription: true })
  );
  const io = createBufferedIO();
  try {
    await assert.rejects(
      deploy({ personaPath, mode: 'dev', dryRun: true, io }),
      /requires --mode cloud/
    );
    assert.ok(!io.messages.find((m) => m.message.startsWith('workspace:')));
  } finally {
    await cleanup();
  }
});

test('deploy --dry-run rejects useSubscription with workforce managed credentials', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ useSubscription: true })
  );
  const io = createBufferedIO();
  try {
    await assert.rejects(
      deploy({ personaPath, mode: 'cloud', dryRun: true, harnessSource: 'managed', io }),
      /use --harness-source oauth/
    );
    assert.ok(!io.messages.find((m) => m.message.startsWith('workspace:')));
  } finally {
    await cleanup();
  }
});

test('deploy --dry-run rejects useSubscription with legacy plan alias', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ useSubscription: true })
  );
  const io = createBufferedIO();
  try {
    await assert.rejects(
      deploy({ personaPath, mode: 'cloud', dryRun: true, harnessSource: 'plan', io }),
      /use --harness-source oauth/
    );
    assert.ok(!io.messages.find((m) => m.message.startsWith('workspace:')));
  } finally {
    await cleanup();
  }
});

test('deploy accepts useSubscription when a subscription resolver is supplied', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ useSubscription: true })
  );
  const io = createBufferedIO();
  try {
    const result = await deploy(
      { personaPath, dryRun: true, io },
      {
        subscription: {
          async isConnected() {
            throw new Error('dry-run should not check subscription status');
          },
          async connect() {
            throw new Error('dry-run should not connect subscriptions');
          }
        }
      }
    );
    assert.equal(result.deploymentId, 'demo');
    assert.ok(io.messages.find((m) => m.message.includes('--dry-run')));
  } finally {
    await cleanup();
  }
});

test('deploy prepares useSubscription BYOK credentials before integration side effects', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      useSubscription: true,
      integrations: { github: {} }
    })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  const order: string[] = [];
  let launchedSelections: Record<string, string> | undefined;
  try {
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (url.endsWith('/provider-credentials/byok')) {
        order.push('subscription-byok');
        assert.equal(init?.method, 'POST');
        assert.deepEqual(JSON.parse(String(init?.body)), {
          modelProvider: 'anthropic',
          model_provider: 'anthropic',
          key: 'sk-test',
          api_key: 'sk-test'
        });
        return jsonResponse({ providerCredentialId: 'cred-byok' }, 201);
      }
      throw new Error(`unexpected URL ${url}`);
    }) as typeof fetch;

    const result = await deploy(
      {
        personaPath,
        mode: 'cloud',
        harnessSource: 'byok',
        byokKey: 'sk-test',
        cloudUrl: 'https://cloud.example.test',
        io
      },
      {
        workspaceAuth: {
          async resolveWorkspace() {
            order.push('workspace');
            return { workspace: 'ws-test', token: 'tok' };
          }
        },
        providerConfigKeys: {
          async resolve() {
            return undefined;
          }
        },
        integrations: {
          async isConnected() {
            order.push('integration-check');
            return true;
          },
          async connect() {
            order.push('integration-connect');
            return { connectionId: 'conn-github' };
          }
        },
        bundle: successfulBundleStager(),
        modes: {
          cloud: {
            async launch(input) {
              order.push('launch');
              launchedSelections = input.credentialSelections;
              return {
                id: 'cloud-1',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    );
    assert.equal(result.deploymentId, 'demo');
    assert.deepEqual(order, ['workspace', 'subscription-byok', 'integration-check', 'launch']);
    assert.deepEqual(launchedSelections, { anthropic: 'cred-byok' });
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy fails clearly when integration is not connected and --no-connect is set', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: { github: {} } })
  );
  const io = createBufferedIO();
  const workspaceAuth: WorkspaceAuth = {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'tok' };
    }
  };
  const integrations: IntegrationConnectResolver = {
    async isConnected() {
      return false;
    },
    async connect() {
      throw new Error('should not be called when --no-connect is set');
    }
  };
  try {
    await assert.rejects(
      deploy(
        { personaPath, mode: 'dev', noConnect: true, io },
        { workspaceAuth, integrations }
      ),
      /failed to connect/
    );
    assert.ok(
      io.messages.find(
        (m) => m.level === 'error' && m.message.includes('prompts are disabled')
      )
    );
  } finally {
    await cleanup();
  }
});

test('deploy connects each missing persona integration before launch', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: { github: {}, notion: {} } })
  );
  const io = createBufferedIO();
  const checked: string[] = [];
  const connected: string[] = [];
  let launched = false;
  const workspaceAuth: WorkspaceAuth = {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'tok' };
    }
  };
  const integrations: IntegrationConnectResolver = {
    async isConnected({ provider }) {
      checked.push(provider);
      return false;
    },
    async connect({ provider }) {
      connected.push(provider);
      return { connectionId: `conn-${provider}` };
    }
  };

  try {
    const result = await deploy(
      { personaPath, mode: 'dev', io },
      {
        workspaceAuth,
        integrations,
        bundle: successfulBundleStager(),
        modes: { dev: successfulDevLauncher(() => { launched = true; }) }
      }
    );

    assert.deepEqual(checked, ['github', 'notion']);
    assert.deepEqual(connected, ['github', 'notion']);
    assert.deepEqual(result.connectedIntegrations, ['github', 'notion']);
    assert.equal(launched, true);
  } finally {
    await cleanup();
  }
});

test('deploy activates optional integrations from supplied persona inputs', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        slack: { optional: true, enabledByInput: 'SLACK_CHANNEL' },
        telegram: { optional: true, enabledByInput: 'TELEGRAM_CHAT' }
      },
      inputs: {
        SLACK_CHANNEL: { description: 'Slack channel', optional: true },
        TELEGRAM_CHAT: { description: 'Telegram chat', optional: true }
      }
    }),
    SLACK_TELEGRAM_AGENT_SRC
  );
  const io = createBufferedIO();
  const checked: string[] = [];
  const connected: string[] = [];
  let stagedIntegrationKeys: string[] = [];
  let launchedTriggerKeys: string[] = [];
  const workspaceAuth: WorkspaceAuth = {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'tok' };
    }
  };
  const integrations: IntegrationConnectResolver = {
    async isConnected({ provider }) {
      checked.push(provider);
      return false;
    },
    async connect({ provider }) {
      connected.push(provider);
      return { connectionId: `conn-${provider}` };
    }
  };
  const bundle: BundleStager = {
    async stage(input) {
      stagedIntegrationKeys = Object.keys(input.persona.integrations ?? {});
      return successfulBundleStager().stage(input);
    }
  };
  const devLauncher: ModeLauncher = {
    async launch(input: ModeLaunchInput) {
      launchedTriggerKeys = Object.keys(input.agent.triggers ?? {});
      return {
        id: 'pid-optional',
        async stop() {
          /* no-op */
        },
        done: Promise.resolve({ code: 0 })
      };
    }
  };

  try {
    await withProcessEnv({ TELEGRAM_CHAT: undefined }, async () => {
      const result = await deploy(
        {
          personaPath,
          mode: 'dev',
          io,
          inputs: { SLACK_CHANNEL: 'C1' }
        },
        {
          workspaceAuth,
          integrations,
          bundle,
          modes: { dev: devLauncher }
        }
      );

      assert.deepEqual(checked, ['slack']);
      assert.deepEqual(connected, ['slack']);
      assert.deepEqual(result.connectedIntegrations, ['slack']);
      assert.deepEqual(stagedIntegrationKeys, ['slack']);
      assert.deepEqual(launchedTriggerKeys, ['slack']);
      assert.ok(
        io.messages.find((m) => m.message.includes('integrations.telegram: optional; skipped'))
      );
    });
  } finally {
    await cleanup();
  }
});

test('deploy collects picker-backed input before pruning an optional integration', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        slack: { optional: true, enabledByInput: 'SLACK_CHANNEL' },
        telegram: { optional: true, enabledByInput: 'TELEGRAM_CHAT' }
      },
      inputs: {
        SLACK_CHANNEL: {
          description: 'Slack channel',
          optional: true,
          picker: { provider: 'slack', resource: 'channels' }
        },
        TELEGRAM_CHAT: { description: 'Telegram chat', optional: true }
      }
    }),
    SLACK_TELEGRAM_AGENT_SRC
  );
  const io = createBufferedIO();
  io.scriptAnswers(['1']);
  const checked: string[] = [];
  const connected: string[] = [];
  let stagedIntegrationKeys: string[] = [];
  let launchedTriggerKeys: string[] = [];
  let launchedInputs: Record<string, string> | undefined;
  let launchedEnv: Record<string, string> | undefined;
  const workspaceAuth: WorkspaceAuth = {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'tok' };
    }
  };
  const integrations: IntegrationConnectResolver = {
    async isConnected({ provider }) {
      checked.push(provider);
      return false;
    },
    async connect({ provider }) {
      connected.push(provider);
      return { connectionId: `conn-${provider}` };
    }
  };
  const integrationOptions: IntegrationOptionsResolver = {
    async list({ provider, resource }) {
      assert.equal(provider, 'slack');
      assert.equal(resource, 'channels');
      return [
        { value: 'C1', label: 'general' },
        { value: 'C2', label: 'deploys' }
      ];
    }
  };
  const bundle: BundleStager = {
    async stage(input) {
      stagedIntegrationKeys = Object.keys(input.persona.integrations ?? {});
      return successfulBundleStager().stage(input);
    }
  };
  const devLauncher: ModeLauncher = {
    async launch(input: ModeLaunchInput) {
      launchedTriggerKeys = Object.keys(input.agent.triggers ?? {});
      launchedInputs = input.inputs;
      launchedEnv = input.env;
      return {
        id: 'pid-optional-picker',
        async stop() {
          /* no-op */
        },
        done: Promise.resolve({ code: 0 })
      };
    }
  };

  try {
    await withProcessEnv({ SLACK_CHANNEL: undefined, TELEGRAM_CHAT: undefined }, async () => {
      const result = await deploy(
        { personaPath, mode: 'dev', io },
        {
          workspaceAuth,
          integrations,
          integrationOptions,
          bundle,
          modes: { dev: devLauncher }
        }
      );

      assert.deepEqual(checked, ['slack']);
      assert.deepEqual(connected, ['slack']);
      assert.deepEqual(result.connectedIntegrations, ['slack']);
      assert.deepEqual(stagedIntegrationKeys, ['slack']);
      assert.deepEqual(launchedTriggerKeys, ['slack']);
      assert.deepEqual(launchedInputs, { SLACK_CHANNEL: 'C1' });
      assert.equal(launchedEnv?.WORKFORCE_INPUT_SLACK_CHANNEL, 'C1');
      assert.ok(
        io.messages.find((m) => m.message.includes('integrations.telegram: optional; skipped'))
      );
    });
  } finally {
    await cleanup();
  }
});

test('deploy forwards env-resolved optional activation input values to launchers', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        slack: { optional: true, enabledByInput: 'SLACK_CHANNEL' }
      },
      inputs: {
        SLACK_CHANNEL: {
          description: 'Slack channel',
          optional: true,
          env: 'AW_SLACK_CHANNEL'
        }
      }
    }),
    `import { defineAgent } from '@agentworkforce/runtime';
export default defineAgent({
  triggers: { slack: [{ on: 'message.created' }] },
  handler: async () => {}
});
`
  );
  const io = createBufferedIO();
  const checked: string[] = [];
  let launchedInputs: Record<string, string> | undefined;
  let launchedEnv: Record<string, string> | undefined;
  const workspaceAuth: WorkspaceAuth = {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'tok' };
    }
  };
  const integrations: IntegrationConnectResolver = {
    async isConnected({ provider }) {
      checked.push(provider);
      return true;
    },
    async connect() {
      throw new Error('should not connect when already connected');
    }
  };

  try {
    await withProcessEnv({ AW_SLACK_CHANNEL: 'C-env' }, async () => {
      const result = await deploy(
        { personaPath, mode: 'cloud', io },
        {
          workspaceAuth,
          integrations,
          providerConfigKeys: {
            async resolve() {
              return undefined;
            }
          },
          bundle: successfulBundleStager(),
          modes: {
            cloud: {
              async launch(input: ModeLaunchInput) {
                launchedInputs = input.inputs;
                launchedEnv = input.env;
                return {
                  id: 'cloud-env-input',
                  async stop() {
                    /* no-op */
                  },
                  done: Promise.resolve({ code: 0 })
                };
              }
            }
          }
        }
      );

      assert.deepEqual(checked, ['slack']);
      assert.deepEqual(result.connectedIntegrations, ['slack']);
      assert.deepEqual(launchedInputs, { SLACK_CHANNEL: 'C-env' });
      assert.equal(launchedEnv?.WORKFORCE_INPUT_SLACK_CHANNEL, 'C-env');
    });
  } finally {
    await cleanup();
  }
});

test('deploy refuses an agent whose optional integration inputs leave no active listeners', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        slack: { optional: true, enabledByInput: 'SLACK_CHANNEL' },
        telegram: { optional: true, enabledByInput: 'TELEGRAM_CHAT' }
      },
      inputs: {
        SLACK_CHANNEL: { description: 'Slack channel', optional: true },
        TELEGRAM_CHAT: { description: 'Telegram chat', optional: true }
      }
    }),
    SLACK_TELEGRAM_AGENT_SRC
  );
  try {
    await withProcessEnv({ SLACK_CHANNEL: undefined, TELEGRAM_CHAT: undefined }, async () =>
      assert.rejects(
        deploy({ personaPath, mode: 'dev', io: createBufferedIO() }),
        /no active listeners after optional integrations were applied/
      )
    );
  } finally {
    await cleanup();
  }
});

test('deploy dev mode injects runtime credentials for a detected writeback trigger without provider-token leakage', async () => {
  const providerTokenSentinel = 'WORKFORCE_PROVIDER_TOKEN_SHOULD_NOT_LEAK';
  const integrations = {
    github: {}
  };
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations }),
    githubAgentSrc()
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  const originalProviderToken = process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN;
  const calls: Array<{ url: string; method: string; body?: unknown }> = [];
  let launchedEnv: Record<string, string> | undefined;
  let launched = false;

  process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN = providerTokenSentinel;
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, ...(body !== undefined ? { body } : {}) });

    if (url.includes('/api/v1/workspaces/ws-test/integrations/github/status')) {
      return jsonResponse({ provider: 'github', status: 'ready' });
    }
    if (url.includes('/api/v1/workspaces/ws-test/runtime-credentials')) {
      assert.equal(method, 'POST');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer relay_ws_workspace');
      assert.deepEqual(body, {
        personaId: 'demo',
        agentId: 'demo',
        integrations: {
          github: {
            source: { kind: 'deployer_user' },
            triggers: [{ on: 'pull_request.opened' }]
          }
        },
        ttlSeconds: 3600
      });
      return jsonResponse({
        relayfileUrl: 'https://relayfile.test',
        relayfileWorkspaceId: 'ws-test',
        relayfileToken: 'relay_pa_scoped',
        relayfileMountPaths: ['/github/repos/**/**/pulls/**']
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    const result = await deploy(
      {
        personaPath,
        mode: 'dev',
        noPrompt: true,
        cloudUrl: 'https://cloud.example.test',
        io
      },
      {
        workspaceAuth: {
          async resolveWorkspace() {
            return { workspace: 'ws-test', token: 'relay_ws_workspace' };
          }
        },
        bundle: successfulBundleStager(),
        modes: {
          dev: {
            async launch(input) {
              launched = true;
              launchedEnv = input.env;
              return {
                id: 'dev-1',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    );

    assert.equal(result.deploymentId, 'demo');
    assert.equal(launched, true);
    assert.equal(launchedEnv?.RELAYFILE_URL, 'https://relayfile.test');
    assert.equal(launchedEnv?.RELAYFILE_WORKSPACE_ID, 'ws-test');
    assert.equal(launchedEnv?.RELAYFILE_TOKEN, 'relay_pa_scoped');
    assert.equal(
      launchedEnv?.RELAYFILE_MOUNT_PATHS,
      JSON.stringify(['/github/repos/**/**/pulls/**'])
    );
    assert.equal(launchedEnv?.WORKFORCE_INTEGRATION_GITHUB_TOKEN, '');
    assert.doesNotMatch(JSON.stringify(launchedEnv), new RegExp(providerTokenSentinel));
    assert.doesNotMatch(JSON.stringify(calls), new RegExp(providerTokenSentinel));
    assert.doesNotMatch(JSON.stringify(io.messages), new RegExp(providerTokenSentinel));
  } finally {
    if (originalProviderToken === undefined) {
      delete process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN;
    } else {
      process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN = originalProviderToken;
    }
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy dev mode preserves no-trigger null-token runtime credentials', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: { github: {} } })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  let launchedEnv: Record<string, string> | undefined;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;

    if (url.includes('/api/v1/workspaces/ws-test/integrations/github/status')) {
      return jsonResponse({ provider: 'github', status: 'ready' });
    }
    if (url.includes('/api/v1/workspaces/ws-test/runtime-credentials')) {
      assert.equal(method, 'POST');
      assert.deepEqual(body, {
        personaId: 'demo',
        agentId: 'demo',
        integrations: {
          github: { source: { kind: 'deployer_user' } }
        },
        ttlSeconds: 3600
      });
      return jsonResponse({
        relayfileUrl: 'https://relayfile.test',
        relayfileWorkspaceId: 'ws-test',
        relayfileToken: null,
        relayfileMountPaths: []
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    await deploy(
      {
        personaPath,
        mode: 'dev',
        noPrompt: true,
        cloudUrl: 'https://cloud.example.test',
        io
      },
      {
        workspaceAuth: {
          async resolveWorkspace() {
            return { workspace: 'ws-test', token: 'relay_ws_workspace' };
          }
        },
        bundle: successfulBundleStager(),
        modes: {
          dev: {
            async launch(input) {
              launchedEnv = input.env;
              return {
                id: 'dev-1',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    );

    assert.equal(launchedEnv?.RELAYFILE_URL, 'https://relayfile.test');
    assert.equal(launchedEnv?.RELAYFILE_WORKSPACE_ID, 'ws-test');
    assert.equal(launchedEnv?.RELAYFILE_TOKEN, '');
    assert.equal(launchedEnv?.RELAYFILE_MOUNT_PATHS, '[]');
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy dev mode preserves env-only provider token fallback without runtime credential masking', async () => {
  const providerTokenSentinel = 'WORKFORCE_ENV_ONLY_PROVIDER_TOKEN';
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        github: {}
      }
    })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  const originalProviderToken = process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN;
  const urls: string[] = [];
  let launched = false;
  let launchedEnv: Record<string, string> | undefined;
  let launchedProcessProviderToken: string | undefined;

  process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN = providerTokenSentinel;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/api/v1/workspaces/ws-test/integrations/github/status')) {
      return jsonResponse({ provider: 'github', status: 'pending' });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    await deploy(
      {
        personaPath,
        mode: 'dev',
        noPrompt: true,
        cloudUrl: 'https://cloud.example.test',
        io
      },
      {
        workspaceAuth: {
          async resolveWorkspace() {
            return { workspace: 'ws-test', token: 'relay_ws_workspace' };
          }
        },
        bundle: successfulBundleStager(),
        modes: {
          dev: {
            async launch(input) {
              launched = true;
              launchedEnv = input.env;
              launchedProcessProviderToken = process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN;
              return {
                id: 'dev-1',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    );

    assert.equal(launched, true);
    assert.equal(launchedEnv, undefined);
    assert.equal(launchedProcessProviderToken, providerTokenSentinel);
    assert.ok(!urls.find((url) => url.endsWith('/runtime-credentials')));
  } finally {
    if (originalProviderToken === undefined) {
      delete process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN;
    } else {
      process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN = originalProviderToken;
    }
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy dev mode runtime credential eligibility preserves legacy workspace fallback semantics', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        github: {}
      }
    })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  let launchedEnv: Record<string, string> | undefined;

  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/api/v1/workspaces/ws-test/integrations/github/status')) {
      const parsed = new URL(url);
      return jsonResponse({
        provider: 'github',
        status: parsed.searchParams.get('scope') === 'workspace' ? 'ready' : 'pending'
      });
    }
    if (url.includes('/api/v1/workspaces/ws-test/runtime-credentials')) {
      return jsonResponse({
        relayfileUrl: 'https://relayfile.test',
        relayfileWorkspaceId: 'ws-test',
        relayfileToken: 'relay_pa_workspace_fallback',
        relayfileMountPaths: ['/github/repos/**/**/pulls/**']
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    await deploy(
      {
        personaPath,
        mode: 'dev',
        noPrompt: true,
        cloudUrl: 'https://cloud.example.test',
        io
      },
      {
        workspaceAuth: {
          async resolveWorkspace() {
            return { workspace: 'ws-test', token: 'relay_ws_workspace' };
          }
        },
        bundle: successfulBundleStager(),
        modes: {
          dev: {
            async launch(input) {
              launchedEnv = input.env;
              return {
                id: 'dev-1',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    );

    assert.equal(launchedEnv?.RELAYFILE_TOKEN, 'relay_pa_workspace_fallback');
    assert.deepEqual(
      urls.filter((url) => url.includes('/integrations/github/status')),
      [
        'https://cloud.example.test/api/v1/workspaces/ws-test/integrations/github/status?scope=deployer_user',
        'https://cloud.example.test/api/v1/workspaces/ws-test/integrations/github/status?scope=workspace',
        'https://cloud.example.test/api/v1/workspaces/ws-test/integrations/github/status?scope=deployer_user',
        'https://cloud.example.test/api/v1/workspaces/ws-test/integrations/github/status?scope=workspace'
      ]
    );
    assert.ok(urls.find((url) => url.endsWith('/runtime-credentials')));
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy dev mode runtime credential eligibility preserves expected provider config key semantics', async () => {
  const providerTokenSentinel = 'WORKFORCE_ENV_CONFIG_MISMATCH_TOKEN';
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        github: {}
      }
    })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  const originalProviderToken = process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN;
  const urls: string[] = [];
  let launchedEnv: Record<string, string> | undefined;
  let launchedProcessProviderToken: string | undefined;

  process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN = providerTokenSentinel;
  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/api/v1/workspaces/ws-test/integrations/github/status')) {
      return jsonResponse({
        provider: 'github',
        providerConfigKey: 'github-other',
        status: 'ready'
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    await deploy(
      {
        personaPath,
        mode: 'dev',
        noPrompt: true,
        cloudUrl: 'https://cloud.example.test',
        io
      },
      {
        workspaceAuth: {
          async resolveWorkspace() {
            return { workspace: 'ws-test', token: 'relay_ws_workspace' };
          }
        },
        providerConfigKeys: {
          async resolve(provider) {
            assert.equal(provider, 'github');
            return 'github-relay';
          }
        },
        bundle: successfulBundleStager(),
        modes: {
          dev: {
            async launch(input) {
              launchedEnv = input.env;
              launchedProcessProviderToken = process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN;
              return {
                id: 'dev-1',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    );

    assert.equal(launchedEnv, undefined);
    assert.equal(launchedProcessProviderToken, providerTokenSentinel);
    assert.ok(!urls.find((url) => url.endsWith('/runtime-credentials')));
  } finally {
    if (originalProviderToken === undefined) {
      delete process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN;
    } else {
      process.env.WORKFORCE_INTEGRATION_GITHUB_TOKEN = originalProviderToken;
    }
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy dev mode ignores catalog config keys for CLI-captured daytona runtime credentials', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        daytona: {}
      }
    })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  const originalProviderToken = process.env.WORKFORCE_INTEGRATION_DAYTONA_TOKEN;
  const urls: string[] = [];
  let catalogLookupCount = 0;
  let launchedEnv: Record<string, string> | undefined;

  process.env.WORKFORCE_INTEGRATION_DAYTONA_TOKEN = 'WORKFORCE_DAYTONA_CONNECT_SENTINEL';
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/api/v1/workspaces/ws-test/integrations/daytona/status')) {
      return jsonResponse({
        provider: 'daytona',
        configKey: 'daytona',
        backend: 'provider-credential',
        ready: true,
        connectionMatched: true,
        oauth: { connected: true }
      });
    }
    if (url.includes('/api/v1/workspaces/ws-test/runtime-credentials')) {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      assert.deepEqual(body, {
        personaId: 'demo',
        agentId: 'demo',
        integrations: {
          daytona: { source: { kind: 'deployer_user' } }
        },
        ttlSeconds: 3600
      });
      return jsonResponse({
        relayfileUrl: 'https://relayfile.test',
        relayfileWorkspaceId: 'ws-test',
        relayfileToken: 'relay_pa_daytona',
        relayfileMountPaths: ['/daytona/sandboxes/**']
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    await deploy(
      {
        personaPath,
        mode: 'dev',
        noPrompt: true,
        cloudUrl: 'https://cloud.example.test',
        io
      },
      {
        workspaceAuth: {
          async resolveWorkspace() {
            return { workspace: 'ws-test', token: 'relay_ws_workspace' };
          }
        },
        providerConfigKeys: {
          async resolve(provider) {
            catalogLookupCount += 1;
            assert.equal(provider, 'daytona');
            return 'daytona-relay';
          }
        },
        bundle: successfulBundleStager(),
        modes: {
          dev: {
            async launch(input) {
              launchedEnv = input.env;
              return {
                id: 'dev-1',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    );

    assert.equal(catalogLookupCount, 0);
    assert.equal(launchedEnv?.RELAYFILE_TOKEN, 'relay_pa_daytona');
    assert.equal(launchedEnv?.WORKFORCE_INTEGRATION_DAYTONA_TOKEN, '');
    assert.ok(urls.find((url) => url.includes('/integrations/daytona/status')));
    assert.ok(urls.find((url) => url.endsWith('/runtime-credentials')));
  } finally {
    if (originalProviderToken === undefined) {
      delete process.env.WORKFORCE_INTEGRATION_DAYTONA_TOKEN;
    } else {
      process.env.WORKFORCE_INTEGRATION_DAYTONA_TOKEN = originalProviderToken;
    }
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy dev mode rejects malformed runtime credential tokens before launch', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        github: {}
      }
    })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  let launched = false;

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('/api/v1/workspaces/ws-test/integrations/github/status')) {
      return jsonResponse({ provider: 'github', status: 'ready' });
    }
    if (url.includes('/api/v1/workspaces/ws-test/runtime-credentials')) {
      return jsonResponse({
        relayfileUrl: 'https://relayfile.test',
        relayfileWorkspaceId: 'ws-test',
        relayfileToken: 'not_relay_pa',
        relayfileMountPaths: ['/github/repos/**/**/pulls/**']
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      deploy(
        {
          personaPath,
          mode: 'dev',
          noPrompt: true,
          cloudUrl: 'https://cloud.example.test',
          io
        },
        {
          workspaceAuth: {
            async resolveWorkspace() {
              return { workspace: 'ws-test', token: 'relay_ws_workspace' };
            }
          },
          bundle: successfulBundleStager(),
          modes: { dev: successfulDevLauncher(() => { launched = true; }) }
        }
      ),
      /runtime-credentials returned a token without expected relay_pa_ prefix/
    );
    assert.equal(launched, false);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy dev mode rejects mismatched relayfile workspace ids before launch', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        github: {}
      }
    })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  let launched = false;

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('/api/v1/workspaces/rw-test/integrations/github/status')) {
      return jsonResponse({ provider: 'github', status: 'ready' });
    }
    if (url.includes('/api/v1/workspaces/rw-test/runtime-credentials')) {
      return jsonResponse({
        relayfileUrl: 'https://relayfile.test',
        relayfileWorkspaceId: 'rf-stale',
        relayfileToken: 'relay_pa_scoped',
        relayfileMountPaths: ['/github/repos/**/**/pulls/**']
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      deploy(
        {
          personaPath,
          mode: 'dev',
          noPrompt: true,
          cloudUrl: 'https://cloud.example.test',
          io
        },
        {
          workspaceAuth: {
            async resolveWorkspace() {
              return {
                workspace: 'rw-test',
                relayfileWorkspaceId: 'rf-canonical',
                token: 'relay_ws_workspace'
              };
            }
          },
          bundle: successfulBundleStager(),
          modes: { dev: successfulDevLauncher(() => { launched = true; }) }
        }
      ),
      /runtime-credentials returned relayfile workspace rf-stale, expected rf-canonical/
    );
    assert.equal(launched, false);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy dev mode rejects runtime credential tokens without mount paths before launch', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        github: {}
      }
    })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  let launched = false;

  globalThis.fetch = (async (input) => {
    const url = String(input);
    if (url.includes('/api/v1/workspaces/ws-test/integrations/github/status')) {
      return jsonResponse({ provider: 'github', status: 'ready' });
    }
    if (url.includes('/api/v1/workspaces/ws-test/runtime-credentials')) {
      return jsonResponse({
        relayfileUrl: 'https://relayfile.test',
        relayfileWorkspaceId: 'ws-test',
        relayfileToken: 'relay_pa_missing_scope',
        relayfileMountPaths: []
      });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      deploy(
        {
          personaPath,
          mode: 'dev',
          noPrompt: true,
          cloudUrl: 'https://cloud.example.test',
          io
        },
        {
          workspaceAuth: {
            async resolveWorkspace() {
              return { workspace: 'ws-test', token: 'relay_ws_workspace' };
            }
          },
          bundle: successfulBundleStager(),
          modes: { dev: successfulDevLauncher(() => { launched = true; }) }
        }
      ),
      /runtime-credentials returned a token without relayfile mount paths/
    );
    assert.equal(launched, false);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy dev mode fails closed before runtime credentials when workspace token is missing', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        github: {}
      }
    })
  );
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('runtime credentials should not be requested without a workspace token');
  }) as typeof fetch;

  try {
    await assert.rejects(
      deploy(
        {
          personaPath,
          mode: 'dev',
          noPrompt: true,
          cloudUrl: 'https://cloud.example.test',
          io: createBufferedIO()
        },
        {
          workspaceAuth: {
            async resolveWorkspace() {
              return { workspace: 'ws-test', token: undefined } as unknown as {
                workspace: string;
                token: string;
              };
            }
          },
          bundle: successfulBundleStager(),
          modes: { dev: successfulDevLauncher() }
        }
      ),
      /workspace token is required for deploy/
    );
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy dev mode still fails fast for genuinely unconnected workspace integrations with --no-prompt', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: {
        github: {}
      }
    })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];

  globalThis.fetch = (async (input) => {
    const url = String(input);
    urls.push(url);
    if (url.includes('/api/v1/workspaces/ws-test/integrations/github/status')) {
      return jsonResponse({ provider: 'github', status: 'pending' });
    }
    throw new Error(`unexpected URL ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(
      deploy(
        {
          personaPath,
          mode: 'dev',
          noPrompt: true,
          cloudUrl: 'https://cloud.example.test',
          io
        },
        {
          workspaceAuth: {
            async resolveWorkspace() {
              return { workspace: 'ws-test', token: 'relay_ws_workspace' };
            }
          },
          bundle: successfulBundleStager(),
          modes: { dev: successfulDevLauncher() }
        }
      ),
      /deploy aborted: 1 integration\(s\) failed to connect: github/
    );
    assert.ok(!urls.find((url) => url.endsWith('/runtime-credentials')));
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy aborts cleanly when one missing integration connect fails', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: { github: {}, notion: {} } })
  );
  const io = createBufferedIO();
  const connected: string[] = [];
  let launched = false;
  const workspaceAuth: WorkspaceAuth = {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'tok' };
    }
  };
  const integrations: IntegrationConnectResolver = {
    async isConnected() {
      return false;
    },
    async connect({ provider }) {
      connected.push(provider);
      if (provider === 'notion') {
        throw new Error('notion oauth unavailable');
      }
      return { connectionId: `conn-${provider}` };
    }
  };

  try {
    await assert.rejects(
      deploy(
        { personaPath, mode: 'dev', io },
        {
          workspaceAuth,
          integrations,
          bundle: successfulBundleStager(),
          modes: { dev: successfulDevLauncher(() => { launched = true; }) }
        }
      ),
      /deploy aborted: 1 integration\(s\) failed to connect: notion/
    );
    assert.deepEqual(connected, ['github', 'notion']);
    assert.equal(launched, false);
    assert.ok(
      io.messages.find(
        (m) => m.level === 'error' && m.message.includes('integrations.notion: connect failed: notion oauth unavailable')
      )
    );
  } finally {
    await cleanup();
  }
});

test('deploy treats --no-prompt as fail-fast for missing integration connects', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: { github: {}, notion: {} } })
  );
  const io = createBufferedIO();
  const checked: string[] = [];
  let connectCalled = false;
  const workspaceAuth: WorkspaceAuth = {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'tok' };
    }
  };
  const integrations: IntegrationConnectResolver = {
    async isConnected({ provider }) {
      checked.push(provider);
      return false;
    },
    async connect() {
      connectCalled = true;
      throw new Error('connect should not be called when --no-prompt is set');
    }
  };

  try {
    await assert.rejects(
      deploy(
        { personaPath, mode: 'dev', noPrompt: true, io },
        { workspaceAuth, integrations }
      ),
      /deploy aborted: 1 integration\(s\) failed to connect: github/
    );
    assert.deepEqual(checked, ['github']);
    assert.equal(connectCalled, false);
    assert.ok(
      io.messages.find(
        (m) => m.level === 'error' && m.message.includes('--no-prompt was passed')
      )
    );
  } finally {
    await cleanup();
  }
});

test('deploy can recover cloud integration auth by logging in and retrying with the fresh token', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: { notion: {} } })
  );
  const io = createBufferedIO();
  const originalFetch = globalThis.fetch;
  const authHeaders: string[] = [];
  let recovered = false;
  let launchedToken: string | undefined;
  const workspaceAuth: WorkspaceAuth = {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'stale-token' };
    }
  };
  const authRecovery: CloudAuthRecoveryResolver = {
    async recover({ workspace, provider, reason }) {
      recovered = true;
      assert.equal(workspace, 'ws-test');
      assert.equal(provider, 'notion');
      assert.match(reason, /unauthorized/);
      return { token: 'fresh-token' };
    }
  };
  globalThis.fetch = (async (input, init) => {
    const url = String(input);
    const auth = String(new Headers(init?.headers).get('authorization'));
    // Catalog fetch is best-effort: don't drive auth recovery from it.
    // Return an empty providers list so the resolver caches that and moves on.
    if (url.includes('/api/v1/integrations/catalog')) {
      return jsonResponse({ providers: [] });
    }
    authHeaders.push(auth);
    if (auth === 'Bearer stale-token') {
      return jsonResponse({ error: 'Unauthorized' }, 401);
    }
    return jsonResponse({ provider: 'notion', configKey: 'notion-relay', status: 'ready' });
  }) as typeof fetch;

  try {
    const result = await deploy(
      { personaPath, mode: 'cloud', io },
      {
        workspaceAuth,
        authRecovery,
        bundle: successfulBundleStager(),
        modes: {
          cloud: {
            async launch(input: ModeLaunchInput) {
              launchedToken = input.workspaceToken;
              return {
                id: 'cloud-1',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    );

    assert.equal(recovered, true);
    assert.deepEqual(authHeaders, ['Bearer stale-token', 'Bearer fresh-token']);
    assert.equal(launchedToken, 'fresh-token');
    assert.deepEqual(result.connectedIntegrations, ['notion']);
  } finally {
    globalThis.fetch = originalFetch;
    await cleanup();
  }
});

test('deploy stages a bundle and hands off to the resolved launcher', async () => {
  const { personaPath, dir, cleanup } = await withTempPersona(basePersonaJson());
  const io = createBufferedIO();
  let stagedTo = '';
  const bundleStager: BundleStager = {
    async stage(input) {
      stagedTo = input.outDir;
      await mkdir(input.outDir, { recursive: true });
      const runner = path.join(input.outDir, 'runner.mjs');
      const bundle = path.join(input.outDir, 'agent.bundle.mjs');
      const personaCopy = path.join(input.outDir, 'persona.json');
      const pkg = path.join(input.outDir, 'package.json');
      await Promise.all([
        writeFile(runner, '', 'utf8'),
        writeFile(bundle, '', 'utf8'),
        writeFile(personaCopy, '{}', 'utf8'),
        writeFile(pkg, '{}', 'utf8')
      ]);
      return {
        runnerPath: runner,
        bundlePath: bundle,
        personaCopyPath: personaCopy,
        packageJsonPath: pkg,
        sizeBytes: 2
      };
    }
  };

  let launched = 0;
  const devLauncher: ModeLauncher = {
    async launch(input) {
      launched += 1;
      assert.equal(input.persona.id, 'demo');
      return {
        id: 'pid-1',
        async stop() {
          /* no-op */
        },
        done: Promise.resolve({ code: 0 })
      };
    }
  };

  const workspaceAuth: WorkspaceAuth = {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'tok' };
    }
  };
  const integrations: IntegrationConnectResolver = {
    async isConnected() {
      return true;
    },
    async connect() {
      throw new Error('connect should not be called when everything is already connected');
    }
  };

  try {
    const result = await deploy(
      { personaPath, mode: 'dev', io },
      { workspaceAuth, integrations, bundle: bundleStager, modes: { dev: devLauncher } }
    );
    assert.equal(launched, 1);
    assert.equal(result.mode, 'dev');
    assert.equal(result.workspace, 'ws-test');
    assert.ok(result.bundleDir.startsWith(dir));
    assert.equal(stagedTo, result.bundleDir);
    assert.ok(io.messages.find((m) => m.message.includes('launched: dev/pid-1')));
  } finally {
    await cleanup();
  }
});

test('deploy --bundle-out emits to the supplied dir and skips launch', async () => {
  const { personaPath, cleanup } = await withTempPersona(basePersonaJson());
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'wf-deploy-out-'));
  const io = createBufferedIO();

  let launched = false;
  const devLauncher: ModeLauncher = {
    async launch() {
      launched = true;
      throw new Error('launch should not run with --bundle-out');
    }
  };
  const bundleStager: BundleStager = {
    async stage(input) {
      await mkdir(input.outDir, { recursive: true });
      const runner = path.join(input.outDir, 'runner.mjs');
      const bundle = path.join(input.outDir, 'agent.bundle.mjs');
      const personaCopy = path.join(input.outDir, 'persona.json');
      const pkg = path.join(input.outDir, 'package.json');
      await Promise.all([
        writeFile(runner, '', 'utf8'),
        writeFile(bundle, '', 'utf8'),
        writeFile(personaCopy, '{}', 'utf8'),
        writeFile(pkg, '{}', 'utf8')
      ]);
      return {
        runnerPath: runner,
        bundlePath: bundle,
        personaCopyPath: personaCopy,
        packageJsonPath: pkg,
        sizeBytes: 1
      };
    }
  };

  try {
    const result = await deploy(
      { personaPath, mode: 'dev', io, bundleOut: outDir },
      {
        workspaceAuth: {
          async resolveWorkspace() {
            return { workspace: 'w', token: 't' };
          }
        },
        integrations: {
          async isConnected() {
            return true;
          },
          async connect() {
            throw new Error('unreachable');
          }
        },
        bundle: bundleStager,
        modes: { dev: devLauncher }
      }
    );
    assert.equal(launched, false);
    assert.equal(result.bundleDir, path.resolve(outDir));
    assert.ok(io.messages.find((m) => m.message.includes('skipping launch')));
  } finally {
    await cleanup();
    await rm(outDir, { recursive: true, force: true });
  }
});

test('--mode cloud skips local integration resolver and hands off to the cloud launcher', async () => {
  const { personaPath, cleanup } = await withTempPersona(basePersonaJson());
  const io = createBufferedIO();
  let launched = false;
  try {
    const result = await deploy(
      { personaPath, mode: 'cloud', io },
      {
        workspaceAuth: {
          async resolveWorkspace() {
            return { workspace: 'w', token: 't' };
          }
        },
        integrations: {
          async isConnected() {
            throw new Error('cloud mode should not use local integration resolver');
          },
          async connect() {
            throw new Error('cloud mode should not use local integration resolver');
          }
        },
        bundle: {
          async stage(input) {
            await mkdir(input.outDir, { recursive: true });
            const runner = path.join(input.outDir, 'runner.mjs');
            const bundle = path.join(input.outDir, 'agent.bundle.mjs');
            const personaCopy = path.join(input.outDir, 'persona.json');
            const pkg = path.join(input.outDir, 'package.json');
            await Promise.all([
              writeFile(runner, '', 'utf8'),
              writeFile(bundle, '', 'utf8'),
              writeFile(personaCopy, '{}', 'utf8'),
              writeFile(pkg, '{}', 'utf8')
            ]);
            return {
              runnerPath: runner,
              bundlePath: bundle,
              personaCopyPath: personaCopy,
              packageJsonPath: pkg,
              sizeBytes: 0
            };
          }
        },
        modes: {
          cloud: {
            async launch(input) {
              launched = true;
              assert.equal(input.workspace, 'w');
              return {
                id: 'agent-cloud',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    );
    assert.equal(result.mode, 'cloud');
    assert.equal(launched, true);
    assert.deepEqual(result.connectedIntegrations, []);
  } finally {
    await cleanup();
  }
});

test('--mode cloud uses the workspace token resolver before launching', async () => {
  const { personaPath, cleanup } = await withTempPersona(basePersonaJson());
  const io = createBufferedIO();
  let launched = false;
  try {
    const result = await withWorkspaceEnv({}, () => deploy(
      { personaPath, mode: 'cloud', io },
      {
        workspaceAuth: {
          async resolveWorkspace() {
            return { workspace: 'w-cloud', token: 'tok-cloud' };
          }
        },
        bundle: {
          async stage(input) {
            await mkdir(input.outDir, { recursive: true });
            const runner = path.join(input.outDir, 'runner.mjs');
            const bundle = path.join(input.outDir, 'agent.bundle.mjs');
            const personaCopy = path.join(input.outDir, 'persona.json');
            const pkg = path.join(input.outDir, 'package.json');
            await Promise.all([
              writeFile(runner, '', 'utf8'),
              writeFile(bundle, '', 'utf8'),
              writeFile(personaCopy, '{}', 'utf8'),
              writeFile(pkg, '{}', 'utf8')
            ]);
            return {
              runnerPath: runner,
              bundlePath: bundle,
              personaCopyPath: personaCopy,
              packageJsonPath: pkg,
              sizeBytes: 0
            };
          }
        },
        modes: {
          cloud: {
            async launch(input) {
              launched = true;
              assert.equal(input.workspace, 'w-cloud');
              assert.equal(input.workspaceToken, 'tok-cloud');
              return {
                id: 'agent-cloud',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    ));
    assert.equal(result.mode, 'cloud');
    assert.equal(result.workspace, 'w-cloud');
    assert.equal(launched, true);
  } finally {
    await cleanup();
  }
});

test('deploy: default auth resolver honors env credentials without a workspaceAuth resolver', async () => {
  // Regression guard for the orchestrator wiring change in this PR. The
  // previous default (`envWorkspaceAuth()`) only consulted env vars and a
  // long-dead keychain; the new default delegates to `resolveWorkspaceToken`,
  // which still honors WORKFORCE_WORKSPACE_TOKEN + WORKFORCE_WORKSPACE_ID
  // as Tier 1 but additionally falls through to the shared cloud session and
  // canonical Agent Relay workspace store. This test exercises the Tier 1 path end-to-end
  // through `deploy()` with no resolver injection — proving the wiring is
  // intact for CI users while the filesystem-fallback paths stay covered
  // by `login.test.ts`.
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: {} })
  );

  await withWorkspaceEnv({ workspace: 'env-ws', token: 'env-tok' }, async () => {
    let launched = false;
    const result = await deploy(
      { personaPath, mode: 'dev', noConnect: true, io: createBufferedIO() },
      {
        bundle: successfulBundleStager(),
        modes: { dev: successfulDevLauncher(() => { launched = true; }) }
      }
    );
    assert.equal(result.workspace, 'env-ws');
    assert.equal(launched, true);
  });

  await cleanup();
});

test('deploy: clear error when nothing resolves and noPrompt is set', async () => {
  // Without env or an explicit resolver, the orchestrator must surface
  // an actionable error rather than wedging in a prompt loop. The temp
  // AGENT_RELAY_HOME gives the SDK an empty canonical workspace store.
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: {} })
  );

  await withWorkspaceEnv({ workspace: undefined, token: undefined }, async () => {
    await withCloudSessionEnv(async () => {
      await withAgentRelayHome(async () => {
      await assert.rejects(
        deploy(
          { personaPath, mode: 'dev', noConnect: true, noPrompt: true, io: createBufferedIO() },
          { bundle: successfulBundleStager(), modes: { dev: successfulDevLauncher() } }
        ),
        /No active Agent Relay workspace found/
      );
      });
    });
  });

  await cleanup();
});

test('deploy merges explicit --input with picker-collected values for the launcher', async () => {
  // Regression: when the operator passes any --input, the public deploy()
  // wrapper used to overwrite the launcher inputs with the CLI set only,
  // dropping picker-collected picks. Assert both reach the launcher.
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({
      integrations: { slack: {} },
      inputs: {
        EXPLICIT: { description: 'set via --input', optional: true },
        BENJAMIN: {
          description: 'picked from slack users',
          optional: true,
          picker: { provider: 'slack', resource: 'users' }
        }
      }
    })
  );
  const io = createBufferedIO();
  io.scriptAnswers(['1']); // numbered-prompt fallback: pick the first user

  const workspaceAuth: WorkspaceAuth = {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'tok' };
    }
  };
  const integrations: IntegrationConnectResolver = {
    async isConnected() {
      return true; // slack already connected → picker fires
    },
    async connect() {
      return { connectionId: 'conn-slack' };
    }
  };
  // Stub so cloud mode doesn't reach for the live catalog endpoint.
  const providerConfigKeys: ProviderConfigKeyResolver = {
    async resolve() {
      return undefined;
    }
  };
  const integrationOptions: IntegrationOptionsResolver = {
    async list({ provider, resource }) {
      assert.equal(provider, 'slack');
      assert.equal(resource, 'users');
      return [
        { value: 'U1', label: 'Benjamin', hint: 'ben@watchdog.no' },
        { value: 'U2', label: 'Amy' }
      ];
    }
  };

  let launchedInputs: Record<string, string> | undefined;
  try {
    await deploy(
      { personaPath, mode: 'cloud', io, inputs: { EXPLICIT: 'explicit-val' } },
      {
        workspaceAuth,
        integrations,
        providerConfigKeys,
        integrationOptions,
        bundle: successfulBundleStager(),
        modes: {
          cloud: {
            async launch(input: ModeLaunchInput) {
              launchedInputs = input.inputs;
              return {
                id: 'cloud-1',
                async stop() {
                  /* no-op */
                },
                done: Promise.resolve({ code: 0 })
              };
            }
          }
        }
      }
    );

    assert.deepEqual(launchedInputs, { EXPLICIT: 'explicit-val', BENJAMIN: 'U1' });
  } finally {
    await cleanup();
  }
});
