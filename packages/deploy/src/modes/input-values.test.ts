import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { deploy } from '../index.js';
import { createBufferedIO } from '../io.js';
import { cloudLauncher } from './cloud.js';
import type {
  BundleResult,
  BundleStager,
  IntegrationConnectResolver,
  ModeLaunchInput,
  ModeLauncher,
  WorkspaceAuth
} from '../index.js';

function personaJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
    inputs: {
      TOPIC: { default: 'AI' },
      REGION: { optional: true }
    },
    ...overrides
  };
}

async function withTempPersona(
  persona: Record<string, unknown>
): Promise<{ dir: string; personaPath: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-deploy-inputs-'));
  const personaPath = path.join(dir, 'persona.json');
  await writeFile(personaPath, JSON.stringify(persona, null, 2), 'utf8');
  await writeFile(path.join(dir, 'agent.ts'), 'export default async () => {};', 'utf8');
  return {
    dir,
    personaPath,
    cleanup: () => rm(dir, { recursive: true, force: true })
  };
}

function testWorkspaceAuth(): WorkspaceAuth {
  return {
    async resolveWorkspace() {
      return { workspace: 'ws-test', token: 'tok' };
    }
  };
}

function connectedIntegrations(): IntegrationConnectResolver {
  return {
    async isConnected() {
      return true;
    },
    async connect() {
      throw new Error('connect should not be called');
    }
  };
}

function testBundleStager(runnerSource = ''): BundleStager {
  return {
    async stage(input) {
      await mkdir(input.outDir, { recursive: true });
      const runner = path.join(input.outDir, 'runner.mjs');
      const bundle = path.join(input.outDir, 'agent.bundle.mjs');
      const personaCopy = path.join(input.outDir, 'persona.json');
      const pkg = path.join(input.outDir, 'package.json');
      await Promise.all([
        writeFile(runner, runnerSource, 'utf8'),
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
}

test('deploy inputs validate against persona spec and forward to mode env', async () => {
  const { personaPath, cleanup } = await withTempPersona(personaJson());
  const io = createBufferedIO();
  let launchInput: ModeLaunchInput | undefined;
  const launcher: ModeLauncher = {
    async launch(input) {
      launchInput = input;
      return {
        id: 'pid-1',
        async stop() {
          /* no-op */
        },
        done: Promise.resolve({ code: 0 })
      };
    }
  };

  try {
    await deploy(
      {
        personaPath,
        mode: 'dev',
        io,
        inputs: { TOPIC: 'Deploy v1', REGION: 'us-east-1' }
      },
      {
        workspaceAuth: testWorkspaceAuth(),
        integrations: connectedIntegrations(),
        bundle: testBundleStager(),
        modes: { dev: launcher }
      }
    );

    assert.deepEqual(launchInput?.inputs, { TOPIC: 'Deploy v1', REGION: 'us-east-1' });
    assert.equal(launchInput?.env?.WORKFORCE_INPUT_TOPIC, 'Deploy v1');
    assert.equal(launchInput?.env?.WORKFORCE_INPUT_REGION, 'us-east-1');
  } finally {
    await cleanup();
  }
});

test('deploy inputs reach the dev launcher child process env', async () => {
  const { dir, personaPath, cleanup } = await withTempPersona(personaJson());
  const observedPath = path.join(dir, 'observed-env.json');
  const runnerSource = [
    "import { writeFileSync } from 'node:fs';",
    `writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({`,
    '  topic: process.env.WORKFORCE_INPUT_TOPIC ?? null,',
    '  region: process.env.WORKFORCE_INPUT_REGION ?? null,',
    '  workspace: process.env.WORKFORCE_WORKSPACE_ID ?? null',
    "}), 'utf8');"
  ].join('\n');

  try {
    const result = await deploy(
      {
        personaPath,
        mode: 'dev',
        io: createBufferedIO(),
        inputs: { TOPIC: 'Deploy v1', REGION: 'eu-west-1' }
      },
      {
        workspaceAuth: testWorkspaceAuth(),
        integrations: connectedIntegrations(),
        bundle: testBundleStager(runnerSource)
      }
    );
    const handle = result.runHandle as { done: Promise<{ code: number }> } | undefined;
    const exit = await handle?.done;

    assert.equal(exit?.code, 0);
    assert.deepEqual(JSON.parse(await readFile(observedPath, 'utf8')), {
      topic: 'Deploy v1',
      region: 'eu-west-1',
      workspace: 'ws-test'
    });
  } finally {
    await cleanup();
  }
});

test('deploy inputs reject undeclared keys with declared input list', async () => {
  const { personaPath, cleanup } = await withTempPersona(personaJson());
  try {
    await assert.rejects(
      deploy({
        personaPath,
        mode: 'dev',
        io: createBufferedIO(),
        inputs: { UNKNOWN: 'x' }
      }),
      /Unknown input 'UNKNOWN'; persona declares: TOPIC, REGION/
    );
  } finally {
    await cleanup();
  }
});

test('deploy inputs reject non-string values with clean error', async () => {
  const { personaPath, cleanup } = await withTempPersona(personaJson());
  try {
    await assert.rejects(
      deploy({
        personaPath,
        mode: 'dev',
        io: createBufferedIO(),
        inputs: { TOPIC: 42 } as unknown as Record<string, string>
      }),
      /Input 'TOPIC' must be a string/
    );
  } finally {
    await cleanup();
  }
});

test('cloud launcher includes inputs in persona bundle POST body', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wf-cloud-inputs-'));
  const oldToken = process.env.WORKFORCE_WORKSPACE_TOKEN;
  const oldFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  try {
    const bundle = await writeBundle(dir);
    process.env.WORKFORCE_WORKSPACE_TOKEN = 'tok-cloud';
	    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
	      const url = typeof input === 'string' ? input : input.toString();
	      calls.push({
	        url,
	        body: init?.body ? JSON.parse(String(init.body)) : undefined
	      });
	      if (url.includes('/provider-credentials/byok')) {
	        return new Response(JSON.stringify({ providerCredentialId: 'cred-byok' }), {
	          status: 200,
	          headers: { 'content-type': 'application/json' }
	        });
	      }
	      return new Response(
        JSON.stringify({ agentId: 'agent-1', deploymentId: 'dep-1', status: 'starting' }),
        { status: 201, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const handle = await cloudLauncher.launch({
      persona: personaJson() as never,
      bundle,
      workspace: 'ws-test',
      cloudUrl: 'https://cloud.example.com',
      inputs: { TOPIC: 'Deploy v1' },
      io: createBufferedIO(),
      workspaceToken: 'tok-cloud',
      noPrompt: true,
      harnessSource: 'byok',
      byokKey: 'sk-test'
    });

    const deployCall = calls.find(
      (c) =>
        c.url === 'https://cloud.example.com/api/v1/workspaces/ws-test/deployments'
    );
    assert.equal(handle.id, 'agent-1');
    assert.ok(deployCall, 'expected a POST to the deployments endpoint');
    assert.deepEqual((deployCall.body as { inputs?: unknown }).inputs, { TOPIC: 'Deploy v1' });
  } finally {
    if (oldToken === undefined) {
      delete process.env.WORKFORCE_WORKSPACE_TOKEN;
    } else {
      process.env.WORKFORCE_WORKSPACE_TOKEN = oldToken;
    }
    globalThis.fetch = oldFetch;
    await rm(dir, { recursive: true, force: true });
  }
});

async function writeBundle(dir: string): Promise<BundleResult> {
  const runnerPath = path.join(dir, 'runner.mjs');
  const bundlePath = path.join(dir, 'agent.bundle.mjs');
  const personaCopyPath = path.join(dir, 'persona.json');
  const packageJsonPath = path.join(dir, 'package.json');
  await Promise.all([
    writeFile(runnerPath, 'runner', 'utf8'),
    writeFile(bundlePath, 'agent', 'utf8'),
    writeFile(personaCopyPath, '{}', 'utf8'),
    writeFile(packageJsonPath, '{"type":"module"}', 'utf8')
  ]);
  return {
    runnerPath,
    bundlePath,
    personaCopyPath,
    packageJsonPath,
    sizeBytes: 1
  };
}
