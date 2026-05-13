import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDeploymentsTable, parseDeploymentListArgs } from './list-command.js';

test('parseDeploymentListArgs accepts deployment list filters', () => {
  assert.deepEqual(
    parseDeploymentListArgs([
      '--workspace',
      'ws-1',
      '--status=active',
      '--persona',
      'weekly-digest',
      '--cloud-url',
      'https://cloud.example.test',
      '--json',
      '--no-prompt'
    ]),
    {
      workspace: 'ws-1',
      status: 'active',
      persona: 'weekly-digest',
      cloudUrl: 'https://cloud.example.test',
      json: true,
      noPrompt: true
    }
  );
});

test('formatDeploymentsTable renders agent rows', () => {
  const out = formatDeploymentsTable([
    {
      agentId: 'b2f111111111111111111111e8c2',
      personaId: 'weekly-digest',
      deployedName: 'Weekly Digest',
      status: 'active',
      createdAt: '2026-05-13T09:11:00.000Z',
      lastUsedAt: null,
      scheduleIds: ['sched-1'],
      deployedByUserId: 'user-1'
    }
  ]);
  assert.match(out, /agentId\s+persona\s+status\s+deployed\s+lastUsed/);
  assert.match(out, /b2f1\.\.\.e8c2/);
  assert.match(out, /weekly-digest/);
  assert.match(out, /2026-05-13 09:11 UTC/);
});
