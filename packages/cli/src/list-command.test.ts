import test from 'node:test';
import assert from 'node:assert/strict';
import {
  formatDeploymentLogEntries,
  formatDeploymentsTable,
  parseDeploymentListArgs,
  parseDeploymentLogsArgs,
  tailLogEntriesFromNewestFiles
} from './list-command.js';

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
      personaId: '7133e815-8c84-5d05-a08b-e434006b11ac',
      personaSlug: 'weekly-digest',
      deployedName: 'Weekly Digest',
      status: 'active',
      createdAt: '2026-05-13T09:11:00.000Z',
      lastUsedAt: null,
      scheduleIds: ['sched-1'],
      deployedByUserId: 'user-1'
    }
  ]);
  assert.match(out, /name\s+status\s+deployed\s+lastUsed\s+agentId/);
  assert.match(out, /b2f1\.\.\.e8c2/);
  assert.match(out, /Weekly Digest/);
  assert.doesNotMatch(out, /7133e815/);
  assert.match(out, /2026-05-13 09:11 UTC/);
});

test('parseDeploymentLogsArgs accepts selector and log flags', () => {
  assert.deepEqual(
    parseDeploymentLogsArgs([
      'Weekly Digest',
      '--workspace=ws-1',
      '--path',
      '/_logs/ws-1/2026-05-19.jsonl',
      '--tail',
      '25',
      '--cloud-url',
      'https://cloud.example.test',
      '--json',
      '--no-prompt'
    ]),
    {
      selector: 'Weekly Digest',
      workspace: 'ws-1',
      path: '/_logs/ws-1/2026-05-19.jsonl',
      tail: 25,
      cloudUrl: 'https://cloud.example.test',
      json: true,
      noPrompt: true
    }
  );
});

test('formatDeploymentLogEntries renders structured log rows', () => {
  const out = formatDeploymentLogEntries([
    {
      ts: '2026-05-19T13:00:00.000Z',
      level: 'info',
      agentId: 'agent-1',
      msg: 'handled event'
    }
  ]);
  assert.match(out, /2026-05-19T13:00:00.000Z\s+INFO\s+agent-1\s+handled event/);
});

test('tailLogEntriesFromNewestFiles keeps the newest entries across files', () => {
  const entries = tailLogEntriesFromNewestFiles(
    [
      [
        { ts: '2026-05-19T13:00:00.000Z', msg: 'newer-a' },
        { ts: '2026-05-19T14:00:00.000Z', msg: 'newer-b' },
        { ts: '2026-05-19T15:00:00.000Z', msg: 'newer-c' }
      ],
      [
        { ts: '2026-05-18T10:00:00.000Z', msg: 'older-a' },
        { ts: '2026-05-18T11:00:00.000Z', msg: 'older-b' }
      ]
    ],
    3
  );

  assert.deepEqual(entries.map((entry) => entry.msg), ['newer-a', 'newer-b', 'newer-c']);
});
