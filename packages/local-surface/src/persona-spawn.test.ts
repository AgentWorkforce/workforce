import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  }
});

test('does not coalesce concurrent launches with distinct agent names', async () => {
  let executeCalls = 0;
  let spawnCalls = 0;
  __setPersonaSpawnImplementationsForTest({
    resolvePersona: () => resolved,
    buildPlan: () => plan,
    checkFleetCompatibility: () => undefined,
    executePlan: async () => {
      executeCalls += 1;
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
  }
});

test('hands relayfile a nonexistent mount path before reaching broker spawn', async () => {
  let spawnCalls = 0;
  __setPersonaSpawnImplementationsForTest({
    resolvePersona: () => resolved,
    buildPlan: () => plan,
    checkFleetCompatibility: () => undefined,
    executePlan: async (_plan, options) => {
      const mountDir = options.mount?.mountDir;
      assert.ok(mountDir);
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
