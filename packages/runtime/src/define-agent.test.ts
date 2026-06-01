import test from 'node:test';
import assert from 'node:assert/strict';

import { defineAgent, isWorkforceAgent, isWorkforceHandler } from './index.js';

test('defineAgent brands the object and wraps the handler', () => {
  const agent = defineAgent({
    triggers: {
      github: [{ on: 'pull_request.opened' }, { on: 'issue_comment.created', match: '@mention' }],
      slack: [{ on: 'app_mention' }]
    },
    schedules: [{ name: 'nightly', cron: '0 2 * * *', tz: 'UTC' }],
    handler: async () => {
      /* no-op */
    }
  });

  assert.equal(isWorkforceAgent(agent), true);
  assert.equal(isWorkforceHandler(agent.handler), true);
  assert.equal(agent.triggers?.github?.length, 2);
  assert.equal(agent.triggers?.slack?.[0]?.on, 'app_mention');
  assert.equal(agent.schedules?.[0]?.name, 'nightly');
  // __workforceAgent is non-enumerable so the listener declarations serialize clean.
  assert.deepEqual(Object.keys(agent).sort(), ['handler', 'schedules', 'triggers']);
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
      if (event.source === 'cron') {
        // `name` is narrowed to the declared schedule names.
        const name: 'nightly' = event.name;
        void name;
      } else {
        // `type` is narrowed to the declared trigger `on` values.
        const type: 'pull_request.opened' = event.type;
        void type;
      }
    }
  });
});
