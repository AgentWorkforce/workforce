import test from 'node:test';
import assert from 'node:assert/strict';
import { lintScopes } from './scopes.js';
import type { PersonaSpec } from './types.js';

function persona(integrations: Record<string, unknown>): PersonaSpec {
  return { id: 'demo', integrations } as unknown as PersonaSpec;
}

test('a concrete subpath scope is clean', () => {
  const issues = lintScopes(
    persona({
      linear: { scope: { projects: '/linear/projects/**', issues: '/linear/issues/**' } },
      slack: { scope: { channel: '/slack/channels/C0B9Z4CLG1J/**' } }
    })
  );
  assert.deepEqual(issues, []);
});

test('an integration with no scope at all is clean', () => {
  // Credential-only providers (an MCP server) have no Relayfile side, so
  // omitting scope is correct and must not warn.
  assert.deepEqual(lintScopes(persona({ 'supabase-mcp': {} })), []);
});

test('an explicitly empty scope object is flagged', () => {
  // Distinct from omitting scope: `scope: {}` reads as "I scoped this" while
  // mirroring nothing, so reads come back empty and writes no-op silently.
  const issues = lintScopes(persona({ slack: { scope: {} } }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'scope_empty');
  assert.equal(issues[0].provider, 'slack');
});

test('a mid-path wildcard is flagged — the mount rejects it silently', () => {
  // cloud's mount-intent allows ONLY a terminal /**; anything else mirrors
  // nothing and the agent reads an empty tree without an error.
  const issues = lintScopes(persona({ slack: { scope: { msgs: '/slack/*/messages' } } }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'scope_mid_path_wildcard');
  assert.equal(issues[0].path, 'integrations.slack.scope.msgs');
});

test('a provider-root mirror is flagged as a cost, not an error', () => {
  const issues = lintScopes(persona({ slack: { scope: { all: '/slack/**' } } }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'scope_provider_root');
  assert.equal(issues[0].level, 'warning');
  assert.match(issues[0].message, /mirrors the whole slack tree/u);
});

test('non-absolute, trailing-slash and traversal scopes are flagged', () => {
  const cases: [string, string][] = [
    ['slack/channels/**', 'scope_not_absolute'],
    ['/slack/channels/', 'scope_trailing_slash'],
    ['/slack/../linear/issues/**', 'scope_traversal_segment']
  ];
  for (const [value, code] of cases) {
    const issues = lintScopes(persona({ slack: { scope: { x: value } } }));
    assert.equal(issues.length, 1, `expected one issue for ${value}`);
    assert.equal(issues[0].code, code, `wrong code for ${value}`);
  }
});

test('never throws on malformed personas', () => {
  assert.deepEqual(lintScopes({ id: 'x' } as unknown as PersonaSpec), []);
  assert.deepEqual(lintScopes(persona({ slack: 'nope' as unknown as object })), []);
  assert.deepEqual(lintScopes(persona({ slack: { scope: { n: 42 as unknown as string } } })), []);
});

test('a bounded collection wildcard is NOT flagged', () => {
  // The lint does not flag terminal /** in general — whether a collection is
  // affordable depends on the workspace, not the glob, and flagging every
  // `/linear/issues/**` would be noise that trains authors to ignore it.
  assert.deepEqual(lintScopes(persona({ linear: { scope: { i: '/linear/issues/**' } } })), []);
});

test('a history-sized collection wildcard IS flagged', () => {
  // The exception to the rule above, and the reason this lint was written:
  // `/slack/channels/**` is syntactically identical to `/linear/issues/**` but
  // mirrored ~5,950 entries in a real workspace and could not converge inside
  // the mount budget. Only collections that grow with history, not with
  // configuration, are on the list.
  const issues = lintScopes(persona({ slack: { scope: { channels: '/slack/channels/**' } } }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'scope_high_cardinality_root');
  assert.match(issues[0].message, /only WRITES here/u);
});

test('a single entry under a history-sized collection is clean', () => {
  // The fix the warning above points at: scoping the one channel the agent
  // posts to must not itself warn, or the advice is unfollowable.
  assert.deepEqual(
    lintScopes(persona({ slack: { scope: { channel: '/slack/channels/C0B9Z4CLG1J/**' } } })),
    []
  );
});
