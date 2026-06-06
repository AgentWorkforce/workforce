import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { createCloudRuntimeDefaults } from './cloud-defaults.js';
import type { WorkforceAgentContext, WorkforceDeploymentContext } from './types.js';

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

const agent: WorkforceAgentContext = {
  id: 'agent_1',
  deployedName: 'docs-demo',
  spawnedByAgentId: null
};

const deployment: WorkforceDeploymentContext = {
  id: 'deployment_1',
  triggerKind: 'clock',
  parentDeploymentId: null
};

const base = { persona, agent, deployment, workspaceId: 'ws-1', log: () => {} };

test('cloud trajectoryRoot: explicit TRAJECTORY_ROOT wins', () => {
  const defaults = createCloudRuntimeDefaults({
    ...base,
    env: { TRAJECTORY_ROOT: '/custom/root', WORKFORCE_SANDBOX_ROOT: '/srv/work' }
  });
  assert.equal(defaults.trajectoryRoot, '/custom/root');
});

test('cloud trajectoryRoot: defaults to <workspaceRoot>/.trajectories in a cloud workspace', () => {
  const defaults = createCloudRuntimeDefaults({
    ...base,
    env: { WORKFORCE_SANDBOX_ROOT: '/srv/work' }
  });
  assert.equal(defaults.trajectoryRoot, path.join('/srv/work', '.trajectories'));
});
