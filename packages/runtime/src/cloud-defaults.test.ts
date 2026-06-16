import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { PersonaSpec } from '@agentworkforce/persona-kit';
import { createCloudRuntimeDefaults, foldHarnessFailureOutput } from './cloud-defaults.js';
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

test('foldHarnessFailureOutput: surfaces stderr on a non-zero exit (the grok ENOENT case)', () => {
  // spawn('grok') ENOENT leaves stdout empty and writes the reason to stderr.
  // Without folding, callers building `... failed (exit 1): ${run.output}`
  // saw a blank detail. The fold makes the cause visible.
  assert.equal(
    foldHarnessFailureOutput({ output: '', stderr: 'spawn grok ENOENT\n', exitCode: 1 }),
    'spawn grok ENOENT'
  );
});

test('foldHarnessFailureOutput: appends stderr after partial stdout on failure', () => {
  assert.equal(
    foldHarnessFailureOutput({ output: 'partial output\n', stderr: 'fatal: boom', exitCode: 1 }),
    'partial output\nfatal: boom'
  );
});

test('foldHarnessFailureOutput: leaves output clean on success even when stderr is noisy', () => {
  // Harnesses routinely log progress/warnings to stderr on success; that must
  // not pollute the returned output.
  assert.equal(
    foldHarnessFailureOutput({ output: '{"ok":true}\n', stderr: 'warn: rate limited', exitCode: 0 }),
    '{"ok":true}'
  );
});

test('foldHarnessFailureOutput: failure with empty stderr returns trimmed stdout only', () => {
  assert.equal(
    foldHarnessFailureOutput({ output: 'only stdout\n', stderr: '   \n', exitCode: 1 }),
    'only stdout'
  );
});
