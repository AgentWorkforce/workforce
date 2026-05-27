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
  ModeLaunchInput,
  ModeLauncher,
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
    schedules: [{ name: 'weekly', cron: '0 9 * * 6' }],
    onEvent: './agent.ts',
    ...overrides
  };
}

async function withTempPersona(
  persona: Record<string, unknown>,
  agentSource = 'export default async () => {};'
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
  await writeFile(path.join(dir, 'agent.ts'), 'export default async () => {};', 'utf8');
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
  schedules: [{ name: 'weekly', cron: '0 9 * * 6' }],
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

test('preflightPersona refuses when no triggers are declared', async () => {
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ schedules: undefined, integrations: undefined })
  );
  try {
    await assert.rejects(preflightPersona(personaPath), /has no triggers/);
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
    basePersonaJson({
      schedules: undefined,
      integrations: {
        github: { triggers: [{ on: 'pull_request.imagined_event' }] }
      }
    })
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

test('deploy --dry-run rejects useSubscription with workforce plan credentials', async () => {
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
      integrations: { github: { triggers: [{ on: 'pull_request.opened' }] } }
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
    basePersonaJson({ integrations: { github: { triggers: [{ on: 'pull_request.opened' }] } } })
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
    return jsonResponse([
      { provider: 'notion', providerConfigKey: 'notion-relay', status: 'ready' }
    ]);
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
  // as Tier 1 but additionally falls through to the shared cloud-auth +
  // active.json pointer. This test exercises the Tier 1 path end-to-end
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
  // an actionable error rather than wedging in a prompt loop. Setting
  // `noPrompt` forces `resolveWorkspaceToken` to throw at Tier 3 instead
  // of opening a browser, so we get a deterministic error path to assert.
  const { personaPath, cleanup } = await withTempPersona(
    basePersonaJson({ integrations: {} })
  );

  await withWorkspaceEnv({ workspace: undefined, token: undefined }, async () => {
    // Point filesystem-backed auth at definitely-missing/disabled paths so the
    // test doesn't accidentally pick up host credentials.
    const previousActiveFile = process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE;
    const previousLoginFile = process.env.WORKFORCE_LOGIN_FILE;
    const previousDisableShared = process.env.WORKFORCE_DISABLE_SHARED_AUTH;
    process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE = path.join(os.tmpdir(), 'wf-deploy-test-missing-active.json');
    process.env.WORKFORCE_LOGIN_FILE = path.join(os.tmpdir(), 'wf-deploy-test-missing-login.json');
    process.env.WORKFORCE_DISABLE_SHARED_AUTH = '1';
    try {
      await assert.rejects(
        deploy(
          { personaPath, mode: 'dev', noConnect: true, noPrompt: true, io: createBufferedIO() },
          { bundle: successfulBundleStager(), modes: { dev: successfulDevLauncher() } }
        ),
        /no workspace credentials resolved|workspace is required for deploy/
      );
    } finally {
      if (previousActiveFile === undefined) {
        delete process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE;
      } else {
        process.env.WORKFORCE_ACTIVE_WORKSPACE_FILE = previousActiveFile;
      }
      if (previousLoginFile === undefined) {
        delete process.env.WORKFORCE_LOGIN_FILE;
      } else {
        process.env.WORKFORCE_LOGIN_FILE = previousLoginFile;
      }
      if (previousDisableShared === undefined) {
        delete process.env.WORKFORCE_DISABLE_SHARED_AUTH;
      } else {
        process.env.WORKFORCE_DISABLE_SHARED_AUTH = previousDisableShared;
      }
    }
  });

  await cleanup();
});
