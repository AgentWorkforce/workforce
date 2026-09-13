import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { invokeNodeHandler, type FleetActionContext } from '@agent-relay/fleet';
import type { PersonaSpawnPlan } from '@agentworkforce/persona-kit';
import type { ResolvedPersonaReference } from '@agentworkforce/persona-registry';

import {
  __setPersonaSpawnImplementationsForTest,
  defineWorkforcePersonaSpawnNode
} from './persona-spawn.js';

const resolved: ResolvedPersonaReference = {
  source: 'built-in',
  warnings: [],
  spec: {
    id: 'reviewer',
    intent: 'review',
    description: 'Reviews code',
    skills: [],
    harness: 'codex',
    model: 'openai-codex/test',
    systemPrompt: 'Standing review instructions',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 60 }
  },
  selection: {
    personaId: 'reviewer',
    harness: 'codex',
    model: 'openai-codex/test',
    systemPrompt: 'Standing review instructions',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 60 },
    skills: [],
    rationale: 'test'
  }
};

const plan: PersonaSpawnPlan = {
  persona: resolved.selection,
  cli: 'codex',
  args: ['-m', 'test'],
  initialPrompt: 'Standing review instructions',
  configFiles: [],
  skills: { harness: 'codex', installs: [] },
  sidecars: [],
  inputs: [],
  env: {}
};

test('coalesces concurrent node/project/persona/name launches and layers the task', async () => {
  const scratchDirs = new Set<string>();
  let executeCalls = 0;
  let spawnCalls = 0;
  let resolveSpawn: ((value: unknown) => void) | undefined;
  let signalSpawnEntered: (() => void) | undefined;
  const spawnEntered = new Promise<void>((resolve) => {
    signalSpawnEntered = resolve;
  });
  const spawnPending = new Promise<unknown>((resolve) => {
    resolveSpawn = resolve;
  });
  __setPersonaSpawnImplementationsForTest({
    resolvePersona: () => resolved,
    buildPlan: () => plan,
    checkFleetCompatibility: () => undefined,
    executePlan: async (_plan, options) => {
      executeCalls += 1;
      assert.equal(options.mount?.autoSync, true);
      assert.ok(options.mount?.mountDir);
      scratchDirs.add(dirname(options.mount.mountDir));
      return { cwd: '/tmp/persona-runtime', dispose: async () => undefined };
    }
  });

  const node = defineWorkforcePersonaSpawnNode({ nodeName: 'persona-node', cwd: '/tmp/project' });
  const spawnAgent = async (input: unknown) => {
    spawnCalls += 1;
    signalSpawnEntered?.();
    const value = input as {
      initialTask?: string;
      agent: {
        args?: string[];
        model?: string;
        harness_config?: { metadata?: Record<string, unknown> };
      };
    };
    assert.equal(value.initialTask, 'Review PR 42');
    assert.deepEqual(value.agent.args, ['-m', 'test', 'Standing review instructions']);
    assert.equal(value.agent.model, 'openai-codex/test');
    assert.deepEqual(value.agent.harness_config?.metadata, {
      workforce_persona: 'reviewer',
      verify_ready: true,
      require_node_registration: true
    });
    return spawnPending;
  };
  const ctx = {
    node: { name: 'persona-node', capabilities: ['spawn:persona'] },
    relay: { sendMessage: async () => undefined },
    spawnAgent
  } satisfies FleetActionContext;

  try {
    const first = invokeNodeHandler(node, 'spawn:persona', {
      name: 'reviewer-42',
      persona: 'reviewer',
      task: 'Review PR 42'
    }, ctx);
    const second = invokeNodeHandler(node, 'spawn:persona', {
      name: 'reviewer-42',
      persona: 'reviewer',
      task: 'Review PR 42'
    }, ctx);
    await spawnEntered;
    assert.equal(executeCalls, 1);
    assert.equal(spawnCalls, 1);
    resolveSpawn?.({ ready: true });
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal((a as { persona: string }).persona, 'reviewer');
  } finally {
    __setPersonaSpawnImplementationsForTest();
    await removeScratchDirs(scratchDirs);
  }
});

test('does not coalesce concurrent launches with distinct agent names', async () => {
  const scratchDirs = new Set<string>();
  let executeCalls = 0;
  let spawnCalls = 0;
  __setPersonaSpawnImplementationsForTest({
    resolvePersona: () => resolved,
    buildPlan: () => plan,
    checkFleetCompatibility: () => undefined,
    executePlan: async (_plan, options) => {
      executeCalls += 1;
      assert.ok(options.mount?.mountDir);
      scratchDirs.add(dirname(options.mount.mountDir));
      return { cwd: `/tmp/persona-runtime-${executeCalls}`, dispose: async () => undefined };
    }
  });

  const node = defineWorkforcePersonaSpawnNode({ nodeName: 'persona-node', cwd: '/tmp/project' });
  const ctx = {
    node: { name: 'persona-node', capabilities: ['spawn:persona'] },
    relay: { sendMessage: async () => undefined },
    spawnAgent: async () => {
      spawnCalls += 1;
      return { ready: true };
    }
  } satisfies FleetActionContext;

  try {
    await Promise.all([
      invokeNodeHandler(node, 'spawn:persona', { name: 'reviewer-42', persona: 'reviewer' }, ctx),
      invokeNodeHandler(node, 'spawn:persona', { name: 'reviewer-43', persona: 'reviewer' }, ctx)
    ]);
    assert.equal(executeCalls, 2);
    assert.equal(spawnCalls, 2);
  } finally {
    __setPersonaSpawnImplementationsForTest();
    await removeScratchDirs(scratchDirs);
  }
});

test('hands relayfile a nonexistent mount path before reaching broker spawn', async () => {
  const scratchDirs = new Set<string>();
  let spawnCalls = 0;
  __setPersonaSpawnImplementationsForTest({
    resolvePersona: () => resolved,
    buildPlan: () => plan,
    checkFleetCompatibility: () => undefined,
    executePlan: async (_plan, options) => {
      const mountDir = options.mount?.mountDir;
      assert.ok(mountDir);
      scratchDirs.add(dirname(mountDir));
      await assert.rejects(stat(mountDir), (error: unknown) => {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      });
      return { cwd: mountDir, dispose: async () => undefined };
    }
  });

  const node = defineWorkforcePersonaSpawnNode({ nodeName: 'persona-node', cwd: '/tmp/project' });
  const ctx = {
    node: { name: 'persona-node', capabilities: ['spawn:persona'] },
    relay: { sendMessage: async () => undefined },
    spawnAgent: async () => {
      spawnCalls += 1;
      return { ready: true };
    }
  } satisfies FleetActionContext;

  try {
    await invokeNodeHandler(
      node,
      'spawn:persona',
      { name: 'reviewer-mount-contract', persona: 'reviewer' },
      ctx
    );
    assert.equal(spawnCalls, 1);
  } finally {
    __setPersonaSpawnImplementationsForTest();
    await removeScratchDirs(scratchDirs);
    for (const scratchDir of scratchDirs) {
      await assert.rejects(stat(scratchDir), (error: unknown) => {
        return (error as NodeJS.ErrnoException).code === 'ENOENT';
      });
    }
  }
});

test('real relayfile mount completes before broker spawn is invoked', async () => {
  const project = await mkdtemp(join(tmpdir(), 'persona-spawn-mount-project-'));
  await writeFile(join(project, 'input.txt'), 'mounted');
  let spawnCalls = 0;
  const brokerReached = new Error('broker spawn reached');
  __setPersonaSpawnImplementationsForTest({
    resolvePersona: () => resolved,
    buildPlan: () => plan,
    checkFleetCompatibility: () => undefined
  });

  const node = defineWorkforcePersonaSpawnNode({ nodeName: 'persona-node', cwd: project });
  const ctx = {
    node: { name: 'persona-node', capabilities: ['spawn:persona'] },
    relay: { sendMessage: async () => undefined },
    spawnAgent: async () => {
      spawnCalls += 1;
      throw brokerReached;
    }
  } satisfies FleetActionContext;

  try {
    await assert.rejects(
      invokeNodeHandler(
        node,
        'spawn:persona',
        { name: 'reviewer-real-mount', persona: 'reviewer' },
        ctx
      ),
      brokerReached
    );
    assert.equal(spawnCalls, 1);
  } finally {
    __setPersonaSpawnImplementationsForTest();
    await rm(project, { recursive: true, force: true });
  }
});

async function removeScratchDirs(scratchDirs: Iterable<string>): Promise<void> {
  await Promise.all(
    [...scratchDirs].map((scratchDir) => rm(scratchDir, { recursive: true, force: true }))
  );
}

test('awaits ownership of the actual handle before delegation and leaves success cleanup to the host', async () => {
  let prepared: import('./persona-spawn.js').WorkforcePersonaExecution | undefined;
  let disposed = 0;
  let spawnCalls = 0;
  let preparedCalls = 0;
  let allowDelegation!: () => void;
  let signalPrepared!: () => void;
  const preparedEntered = new Promise<void>((resolve) => { signalPrepared = resolve; });
  const custodyBanked = new Promise<void>((resolve) => { allowDelegation = resolve; });
  const handle = { cwd: '/tmp/persona-runtime', dispose: async () => { disposed += 1; } };
  __setPersonaSpawnImplementationsForTest({
    resolvePersona: () => resolved,
    buildPlan: () => plan,
    checkFleetCompatibility: () => undefined,
    executePlan: async () => handle
  });
  const node = defineWorkforcePersonaSpawnNode({
    nodeName: 'persona-node',
    async onExecutionPrepared(name, execution) {
      assert.equal(name, 'owned-reviewer');
      assert.equal(execution.handle, handle);
      assert.ok((await stat(execution.scratchDir)).isDirectory());
      prepared = execution;
      preparedCalls += 1;
      signalPrepared();
      await custodyBanked;
    }
  });
  const ctx = {
    node: { name: 'persona-node', capabilities: ['spawn:persona'] },
    relay: { sendMessage: async () => undefined },
    spawnAgent: async (input) => {
      spawnCalls += 1;
      assert.equal(disposed, 0);
      assert.deepEqual(input.agent.channels, ['owned-a', 'owned-b']);
      return { ready: true };
    }
  } satisfies FleetActionContext;
  const input = { name: 'owned-reviewer', persona: 'reviewer', channels: ['owned-a', 'owned-b'] };
  let launches: Promise<unknown>[] = [];
  try {
    launches = [invokeNodeHandler(node, 'spawn:persona', input, ctx)];
    await preparedEntered;
    launches.push(invokeNodeHandler(node, 'spawn:persona', input, ctx));
    assert.equal(spawnCalls, 0, 'delegation must wait for durable ownership');
    allowDelegation();
    await Promise.all(launches);
    assert.equal(preparedCalls, 1, 'coalesced launch must publish only one handle');
    assert.equal(spawnCalls, 1);
    assert.equal(disposed, 0, 'factory must not dispose a running worker mount');
    assert.ok(prepared);
    // The host has now completed its worker-release contract. Use the exact
    // retained executor handle, never a separately constructed cleanup handle.
    await prepared.handle.dispose();
    await rm(prepared.scratchDir, { recursive: true, force: true });
    assert.equal(disposed, 1);
    await assert.rejects(stat(prepared.scratchDir), { code: 'ENOENT' });
  } finally {
    allowDelegation();
    await Promise.allSettled(launches);
    __setPersonaSpawnImplementationsForTest();
    if (prepared) await rm(prepared.scratchDir, { recursive: true, force: true });
  }
});

for (const failure of ['ownership', 'delegation', 'dispose'] as const) {
  test(`cleans the prepared resources after ${failure} failure`, async () => {
    let prepared: import('./persona-spawn.js').WorkforcePersonaExecution | undefined;
    let disposed = 0;
    let spawnCalls = 0;
    const launchError = new Error('launch rejected');
    const disposeError = new Error('dispose rejected');
    const handle = {
      cwd: '/tmp/persona-runtime',
      async dispose() {
        disposed += 1;
        if (failure === 'dispose') throw disposeError;
      }
    };
    __setPersonaSpawnImplementationsForTest({
      resolvePersona: () => resolved,
      buildPlan: () => plan,
      checkFleetCompatibility: () => undefined,
      executePlan: async () => handle
    });
    const node = defineWorkforcePersonaSpawnNode({
      nodeName: 'persona-node',
      async onExecutionPrepared(name, execution) {
        assert.equal(name, 'owned-reviewer');
        assert.equal(execution.handle, handle);
        prepared = execution;
        if (failure !== 'delegation') throw launchError;
      }
    });
    const ctx = {
      node: { name: 'persona-node', capabilities: ['spawn:persona'] },
      relay: { sendMessage: async () => undefined },
      spawnAgent: async () => {
        spawnCalls += 1;
        assert.ok(prepared);
        assert.equal(disposed, 0);
        throw launchError;
      }
    } satisfies FleetActionContext;
    try {
      await assert.rejects(
        invokeNodeHandler(node, 'spawn:persona', { name: 'owned-reviewer', persona: 'reviewer' }, ctx),
        failure === 'dispose' ? disposeError : launchError
      );
      assert.equal(spawnCalls, failure === 'delegation' ? 1 : 0);
      assert.equal(disposed, 1);
      assert.ok(prepared);
      await assert.rejects(stat(prepared.scratchDir), { code: 'ENOENT' });
    } finally {
      __setPersonaSpawnImplementationsForTest();
      if (prepared) await rm(prepared.scratchDir, { recursive: true, force: true });
    }
  });
}


test('host disposes the real executor mount retained after a successful spawn', async () => {
  const project = await mkdtemp(join(tmpdir(), 'persona-spawn-owned-project-'));
  await writeFile(join(project, 'input.txt'), 'owned project contents');
  let prepared: import('./persona-spawn.js').WorkforcePersonaExecution | undefined;
  __setPersonaSpawnImplementationsForTest({
    resolvePersona: () => resolved,
    buildPlan: () => plan,
    checkFleetCompatibility: () => undefined
  });
  const node = defineWorkforcePersonaSpawnNode({
    nodeName: 'persona-node',
    cwd: project,
    onExecutionPrepared(_name, execution) { prepared = execution; }
  });
  const ctx = {
    node: { name: 'persona-node', capabilities: ['spawn:persona'] },
    relay: { sendMessage: async () => undefined },
    spawnAgent: async (input) => {
      assert.ok(prepared);
      assert.equal(input.agent.cwd, prepared.handle.cwd);
      assert.equal(await readFile(join(prepared.handle.cwd, 'input.txt'), 'utf8'), 'owned project contents');
      return { ready: true };
    }
  } satisfies FleetActionContext;
  try {
    await invokeNodeHandler(node, 'spawn:persona', { name: 'owned-real-mount', persona: 'reviewer' }, ctx);
    assert.ok(prepared);
    assert.ok((await stat(prepared.handle.cwd)).isDirectory());
    await prepared.handle.dispose();
    await rm(prepared.scratchDir, { recursive: true, force: true });
    await assert.rejects(stat(prepared.handle.cwd), { code: 'ENOENT' });
    await assert.rejects(stat(prepared.scratchDir), { code: 'ENOENT' });
    assert.equal(await readFile(join(project, 'input.txt'), 'utf8'), 'owned project contents');
  } finally {
    __setPersonaSpawnImplementationsForTest();
    if (prepared) {
      await prepared.handle.dispose();
      await rm(prepared.scratchDir, { recursive: true, force: true });
    }
    await rm(project, { recursive: true, force: true });
  }
});
