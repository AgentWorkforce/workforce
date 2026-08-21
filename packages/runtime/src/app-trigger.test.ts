import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent } from './types.js';
import { readAppTriggerIntent } from './app-trigger.js';
import { envelopeToAgentEvent } from './to-agent-event.js';

test('readAppTriggerIntent returns the caller payload from an app-triggered cron event', async () => {
  const event = envelopeToAgentEvent({
    id: 'app-trigger-1',
    workspace: 'workspace-1',
    type: 'cron.tick',
    occurredAt: '2026-08-21T10:00:00Z',
    name: 'manual',
    resource: {
      source: 'app.trigger',
      payload: { accountId: 'acme', reason: 'usage_spike' }
    }
  });
  assert.ok(event);

  assert.deepEqual(await readAppTriggerIntent(event), {
    kind: 'app-trigger',
    payload: { accountId: 'acme', reason: 'usage_spike' }
  });
});

test('readAppTriggerIntent distinguishes scheduled ticks from app triggers', async () => {
  const event = envelopeToAgentEvent({
    id: 'scheduled-1',
    workspace: 'workspace-1',
    type: 'cron.tick',
    occurredAt: '2026-08-21T10:00:00Z',
    name: 'hourly',
    cron: '0 * * * *'
  });
  assert.ok(event);

  assert.deepEqual(await readAppTriggerIntent(event), { kind: 'not-app-trigger' });
});

test('readAppTriggerIntent does not mistake provider data for an app trigger', async () => {
  const event = envelopeToAgentEvent({
    id: 'github-1',
    workspace: 'workspace-1',
    type: 'github.issue.opened',
    occurredAt: '2026-08-21T10:00:00Z',
    resource: { issue: { number: 42 } }
  });
  assert.ok(event);

  assert.deepEqual(await readAppTriggerIntent(event), { kind: 'not-app-trigger' });
});

test('readAppTriggerIntent reports missing and non-object payloads as malformed', async () => {
  const eventWith = (data: unknown) => ({
    expand: async () => ({ data })
  }) as unknown as Pick<AgentEvent, 'expand'>;

  assert.deepEqual(
    await readAppTriggerIntent(eventWith({ source: 'app.trigger' })),
    { kind: 'malformed-app-trigger', reason: 'missing-payload' }
  );
  assert.deepEqual(
    await readAppTriggerIntent(eventWith({ source: 'app.trigger', payload: [] })),
    { kind: 'malformed-app-trigger', reason: 'payload-not-object', payload: [] }
  );
  assert.deepEqual(
    await readAppTriggerIntent(eventWith({ source: 'app.trigger', payload: null })),
    { kind: 'malformed-app-trigger', reason: 'payload-not-object', payload: null }
  );
});

test('readAppTriggerIntent accepts the older nested resource wrapper', async () => {
  const event = {
    expand: async () => ({
      data: {
        resource: {
          source: 'app.trigger',
          payload: { mode: 'backfill' }
        }
      }
    })
  } as unknown as Pick<AgentEvent, 'expand'>;

  assert.deepEqual(await readAppTriggerIntent(event), {
    kind: 'app-trigger',
    payload: { mode: 'backfill' }
  });
});
