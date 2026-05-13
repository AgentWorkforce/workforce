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
  IntegrationConnectResolver,
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
