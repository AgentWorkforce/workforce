import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { buildCtx } from './ctx.js';
import type { SandboxContext } from './types.js';

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

function ctxFor(persona: PersonaSpec, inputValues?: Record<string, string | number | boolean | null | undefined>) {
  return buildCtx({
    persona,
    workspaceId: 'ws-test',
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
