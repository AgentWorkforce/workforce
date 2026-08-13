import test from 'node:test';
import assert from 'node:assert/strict';

import { defineAgent, isWorkforceAgent, isWorkforceHandler, unwrapResourceRecord } from './index.js';
import type {
  LinearAgentSessionPayload,
  LinearAppUserNotificationPayload
} from './types.js';

test('defineAgent brands the object and wraps the handler', () => {
  const agent = defineAgent({
    launchedBy: 'team-dispatcher',
    triggers: {
      github: [
        { on: 'pull_request.opened' },
        {
          on: 'issue_comment.created',
          match: '@mention',
          paths: ['/github/repos/AgentWorkforce/workforce/issues/**']
        }
      ],
      slack: [{ on: 'app_mention', paths: ['/slack/channels/C_REVIEW/**'] }]
    },
    schedules: [{ name: 'nightly', cron: '0 2 * * *', tz: 'UTC' }],
    handler: async () => {
      /* no-op */
    }
  });

  assert.equal(isWorkforceAgent(agent), true);
  assert.equal(isWorkforceHandler(agent.handler), true);
  assert.equal(agent.triggers?.github?.length, 2);
  assert.deepEqual(agent.triggers?.github?.[1]?.paths, [
    '/github/repos/AgentWorkforce/workforce/issues/**'
  ]);
  assert.equal(agent.triggers?.slack?.[0]?.on, 'app_mention');
  assert.deepEqual(agent.triggers?.slack?.[0]?.paths, ['/slack/channels/C_REVIEW/**']);
  assert.equal(agent.schedules?.[0]?.name, 'nightly');
  assert.equal(agent.launchedBy, 'team-dispatcher');
  // __workforceAgent is non-enumerable so the listener declarations serialize clean.
  assert.deepEqual(Object.keys(agent).sort(), ['handler', 'launchedBy', 'schedules', 'triggers']);
});

test('defineAgent omits absent listener fields and requires a function handler', () => {
  const agent = defineAgent({
    schedules: [{ name: 'weekly', cron: '0 9 * * 6' }],
    handler: () => {}
  });
  assert.equal('triggers' in agent, false);
  assert.equal('watch' in agent, false);

  assert.throws(
    // @ts-expect-error handler must be a function
    () => defineAgent({ handler: 'nope' }),
    /handler must be a function/
  );
});

test('isWorkforceAgent rejects bare handlers and plain objects', () => {
  assert.equal(isWorkforceAgent(() => {}), false);
  assert.equal(isWorkforceAgent({ handler: () => {} }), false);
  assert.equal(isWorkforceAgent(null), false);
});

test('defineAgent narrows the handler event type to declared triggers/schedules', () => {
  defineAgent({
    triggers: { github: [{ on: 'pull_request.opened' }] },
    schedules: [{ name: 'nightly', cron: '0 2 * * *' }],
    handler: async (_ctx, event) => {
      // v4: `event.type` is narrowed to the provider-qualified trigger types
      // plus `cron.tick` — the relay SDK / cloud envelope form.
      const type: 'github.pull_request.opened' | 'cron.tick' = event.type;
      void type;
      if (event.type === 'github.pull_request.opened') {
        // Provider payload is reached via expand, not a sync `.payload`.
        const full = await event.expand('full');
        void full.data;
      }
    }
  });
});

test('defineAgent narrows Linear agent-session payloads for declared triggers', () => {
  defineAgent({
    triggers: {
      linear: [
        { on: 'AgentSessionEvent.created' },
        { on: 'AgentSessionEvent.prompted' },
        { on: 'AppUserNotification.issueCommentMention' }
      ]
    },
    handler: async (_ctx, event) => {
      // v4: trigger `on` literals narrow `event.type` to the provider-qualified
      // `linear.<on>` form; the payload data comes from `expand('full')`.
      const type:
        | 'linear.AgentSessionEvent.created'
        | 'linear.AgentSessionEvent.prompted'
        | 'linear.AppUserNotification.issueCommentMention' = event.type;
      void type;
      if (event.type === 'linear.AgentSessionEvent.created') {
        const record = unwrapResourceRecord<LinearAgentSessionPayload>((await event.expand('full')).data);
        if (!isLinearAgentSessionPayload(record)) return;
        const sessionId: string = record.agentSession.id;
        void sessionId;
        return;
      }
      if (event.type === 'linear.AgentSessionEvent.prompted') {
        const record = unwrapResourceRecord<LinearAgentSessionPayload>((await event.expand('full')).data);
        if (!isLinearAgentSessionPayload(record)) return;
        void record.agentActivity?.body;
        return;
      }
      const record = unwrapResourceRecord<LinearAppUserNotificationPayload>((await event.expand('full')).data);
      if (!isLinearAppUserNotificationPayload(record)) return;
      void (record.notification?.issue?.id ?? record.issue?.id);
    }
  });
});

test('unwrapResourceRecord unwraps the real relayfile resource payload container', () => {
  const record = unwrapResourceRecord<{
    body?: string;
    issue_id?: string;
    issue_identifier?: string;
  }>({
    resource: {
      provider: 'linear',
      objectType: 'comment',
      payload: {
        body: '@agentrelay please implement this.',
        issue_id: '5d6f2e15-0000-4000-8000-000000000000',
        issue_identifier: 'AR-70'
      }
    }
  });

  assert.equal(isRecord(record), true);
  if (!isRecord(record)) return;
  assert.equal(record.body, '@agentrelay please implement this.');
  assert.equal(record.issue_id, '5d6f2e15-0000-4000-8000-000000000000');
  assert.equal(record.issue_identifier, 'AR-70');
});

function isLinearAgentSessionPayload(value: unknown): value is LinearAgentSessionPayload {
  return isRecord(value) && isRecord(value.agentSession) && typeof value.agentSession.id === 'string';
}

function isLinearAppUserNotificationPayload(value: unknown): value is LinearAppUserNotificationPayload {
  return isRecord(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
