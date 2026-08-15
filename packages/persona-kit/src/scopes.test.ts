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

test('provider filter metadata is left alone', () => {
  // `scope` is overloaded: PersonaIntegrationConfig documents it as
  // provider-specific filter metadata, and these are the documented examples.
  // Treating them as malformed paths would warn on every github/notion/linear
  // persona in the fleet, which is exactly how a warning channel dies.
  const issues = lintScopes(
    persona({
      github: { scope: { repo: 'org/repo' } },
      notion: { scope: { database: 'abc123' } },
      linear: { scope: { team: 'ENG' } }
    })
  );
  assert.deepEqual(issues, []);
});

test('an empty scope object is not flagged — the parser drops it first', () => {
  // parseIntegrationConfig only assigns out.scope when the parsed map is
  // non-empty, so by deploy time `scope: {}` is indistinguishable from an
  // omitted scope. Warning here would advertise protection that does not exist.
  assert.deepEqual(lintScopes(persona({ slack: { scope: {} } })), []);
});

test('an empty scope VALUE is flagged', () => {
  // Unlike `scope: {}`, an empty string survives parseStringMap verbatim and
  // reaches the mount, where it matches nothing under either interpretation.
  const issues = lintScopes(persona({ slack: { scope: { channels: '   ' } } }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'scope_empty_value');
});

test('a padded path is flagged, not silently accepted', () => {
  // parseStringMap does not trim, so deploy forwards the padded string. Linting
  // a trimmed copy would pass a value the mount then fails to match.
  const issues = lintScopes(persona({ slack: { scope: { c: ' /slack/channels/C1/** ' } } }));
  assert.equal(issues.length, 1);
  assert.equal(issues[0].code, 'scope_untrimmed');
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

test('trailing-slash and traversal paths are flagged', () => {
  const cases: [string, string][] = [
    ['/slack/channels/', 'scope_trailing_slash'],
    ['/slack/../linear/issues/**', 'scope_traversal_segment']
  ];
  for (const [value, code] of cases) {
    const issues = lintScopes(persona({ slack: { scope: { x: value } } }));
    assert.equal(issues.length, 1, `expected one issue for ${value}`);
    assert.equal(issues[0].code, code, `wrong code for ${value}`);
  }
});

test('a path missing its leading slash is NOT flagged', () => {
  // Ambiguous by construction: `slack/channels/**` may be a forgotten anchor or
  // deliberate filter metadata, and nothing in the value distinguishes them.
  // The lint stays silent rather than guess — see `provider filter metadata`.
  assert.deepEqual(lintScopes(persona({ slack: { scope: { x: 'slack/channels/**' } } })), []);
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
