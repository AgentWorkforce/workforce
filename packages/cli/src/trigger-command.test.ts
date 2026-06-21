import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildTriggerUrl,
  formatTriggerResult,
  parseTriggerArgs,
  parseTriggerResponse
} from './trigger-command.js';

test('parseTriggerArgs accepts selector and cloud flags', () => {
  assert.deepEqual(
    parseTriggerArgs([
      'hn-monitor',
      '--workspace',
      'rw_123',
      '--cloud-url=https://cloud.example.test',
      '--json',
      '--no-prompt'
    ]),
    {
      selector: 'hn-monitor',
      workspace: 'rw_123',
      cloudUrl: 'https://cloud.example.test',
      json: true,
      noPrompt: true
    }
  );
});

test('parseTriggerArgs supports help sentinel', () => {
  assert.deepEqual(parseTriggerArgs(['--help']), { help: true });
});

test('parseTriggerArgs rejects missing selector and extra positionals', () => {
  assert.throws(() => parseTriggerArgs([]), /missing agent selector/);
  assert.throws(() => parseTriggerArgs(['a', 'b']), /unexpected positional argument "b"/);
});

test('parseTriggerArgs rejects unknown single-dash flags as flags, not selectors', () => {
  assert.throws(() => parseTriggerArgs(['-x']), /unknown flag "-x"/);
});

test('parseTriggerArgs does not swallow single-dash flags as option values', () => {
  assert.throws(() => parseTriggerArgs(['hn-monitor', '--workspace', '-x']), /--workspace expects a value/);
  assert.throws(() => parseTriggerArgs(['hn-monitor', '--cloud-url', '-x']), /--cloud-url expects a value/);
});

test('parseTriggerResponse validates cloud trigger response shape', () => {
  assert.deepEqual(
    parseTriggerResponse(
      {
        agentId: 'agent-1',
        workspaceId: 'rw_123',
        deploymentId: 'deployment-1',
        status: 'starting'
      },
      'hn-monitor'
    ),
    {
      agentId: 'agent-1',
      workspaceId: 'rw_123',
      deploymentId: 'deployment-1',
      status: 'starting'
    }
  );

  assert.throws(
    () => parseTriggerResponse({ agentId: 'agent-1' }, 'hn-monitor'),
    /incomplete response/
  );
});

test('formatTriggerResult prints a concise human summary', () => {
  assert.equal(
    formatTriggerResult({
      agentId: 'agent-1',
      workspaceId: 'rw_123',
      deploymentId: 'deployment-1',
      status: 'starting'
    }),
    'triggered: agent-1\ndeployment: deployment-1\nworkspace: rw_123\nstatus: starting\n'
  );
});

test('buildTriggerUrl preserves cloud base paths', () => {
  assert.equal(
    buildTriggerUrl({
      cloudUrl: 'https://agentrelay.com/cloud',
      workspace: 'rw_123',
      agentId: 'agent-1'
    }).toString(),
    'https://agentrelay.com/cloud/api/v1/workspaces/rw_123/deployments/agent-1/trigger'
  );
});
