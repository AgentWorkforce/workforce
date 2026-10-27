import test from 'node:test';
import assert from 'node:assert/strict';
import { KNOWN_TRIGGERS, lintTriggers } from './triggers.js';
import type { AgentSpec } from './types.js';

function agentWithTriggers(triggers: AgentSpec['triggers']): AgentSpec {
  return { ...(triggers ? { triggers } : {}) };
}

test('KNOWN_TRIGGERS ships a non-empty list per shipped provider', () => {
  for (const [provider, names] of Object.entries(KNOWN_TRIGGERS)) {
    assert.ok(
      names.length > 0,
      `provider ${provider} must declare at least one known trigger`
    );
    for (const name of names) {
      assert.equal(typeof name, 'string');
      assert.notEqual(name, '', `provider ${provider} must not declare an empty trigger name`);
    }
  }
});

test('lintTriggers returns no issues for an agent with no triggers', () => {
  assert.deepEqual(lintTriggers(agentWithTriggers(undefined)), []);
});

test('lintTriggers returns no issues for known providers and known triggers', () => {
  const issues = lintTriggers(
    agentWithTriggers({
      github: [
        { on: 'pull_request.opened' },
        { on: 'pull_request_review_comment.created' }
      ],
      linear: [
        { on: 'issue.create' },
        { on: 'AgentSessionEvent.created' },
        { on: 'AgentSessionEvent.prompted' },
        { on: 'AppUserNotification.issueCommentMention' }
      ],
      slack: [{ on: 'message.created' }]
    })
  );
  assert.deepEqual(issues, []);
});

test('lintTriggers accepts cloud provider aliases backed by adapter trigger catalogs', () => {
  const issues = lintTriggers(
    agentWithTriggers({
      'google-mail': [{ on: 'file.created' }]
    })
  );
  assert.deepEqual(issues, []);
});

test('lintTriggers accepts Neon sync-delta trigger events', () => {
  const issues = lintTriggers(
    agentWithTriggers({
      neon: [
        { on: 'operation.failed' },
        { on: 'endpoint.state_changed' },
        { on: 'advisor.issue_raised' }
      ]
    })
  );
  assert.deepEqual(issues, []);
});

test('lintTriggers warns per unknown trigger for aliased cloud providers', () => {
  const issues = lintTriggers(
    agentWithTriggers({
      'google-mail': [{ on: 'made.up' }]
    })
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'warning');
  assert.equal(issues[0].code, 'unknown_trigger');
  assert.equal(issues[0].provider, 'google-mail');
  assert.equal(issues[0].trigger, 'made.up');
  assert.equal(issues[0].path, 'triggers.google-mail[0].on');
});

test('lintTriggers warns once per unknown provider', () => {
  const issues = lintTriggers(
    agentWithTriggers({
      mysteryapp: [{ on: 'thing.opened' }, { on: 'thing.closed' }]
    })
  );
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'warning');
  assert.equal(issues[0].code, 'unknown_provider');
  assert.equal(issues[0].provider, 'mysteryapp');
  assert.equal(issues[0].path, 'triggers.mysteryapp');
});

test('lintTriggers warns per unknown trigger for a known provider', () => {
  const issues = lintTriggers(
    agentWithTriggers({
      github: [
        { on: 'pull_request.opened' },
        { on: 'pull_request.really_truly_new_event' },
        { on: 'made.up' }
      ]
    })
  );
  const triggers = issues.map((i) => i.trigger).sort();
  assert.deepEqual(triggers, ['made.up', 'pull_request.really_truly_new_event']);
  for (const issue of issues) {
    assert.equal(issue.level, 'warning');
    assert.equal(issue.code, 'unknown_trigger');
    assert.equal(issue.provider, 'github');
    assert.match(issue.path, /triggers\.github\[\d+\]\.on/);
  }
});

test('lintTriggers returns no issues for valid relayfile watch rules', () => {
  const issues = lintTriggers({
    watch: [
      {
        paths: ['/integrations/github/repos/acme/web/issues/**/*.json'],
        events: ['created', 'updated'],
        debounceMs: 5000
      }
    ]
  });
  assert.deepEqual(issues, []);
});

test('lintTriggers warns for non-absolute relayfile watch paths', () => {
  const issues = lintTriggers({
    watch: [{ paths: ['integrations/github/**'], events: ['updated'] }]
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'warning');
  assert.equal(issues[0].code, 'watch_path_not_absolute');
  assert.equal(issues[0].provider, 'relayfile');
  assert.equal(issues[0].path, 'watch[0].paths[0]');
});

test('lintTriggers warns for relayfile watch rules with empty events', () => {
  const issues = lintTriggers({
    watch: [{ paths: ['/integrations/github/**'], events: [] }]
  });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].level, 'warning');
  assert.equal(issues[0].code, 'watch_empty_events');
  assert.equal(issues[0].provider, 'relayfile');
  assert.equal(issues[0].path, 'watch[0].events');
});
