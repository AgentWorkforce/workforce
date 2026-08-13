import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRelay, parsePersonaSpec } from './parse.js';
import { resolvePersonaRelayMcp } from './interactive-spec.js';

test('parseRelay accepts the boolean shorthand', () => {
  assert.equal(parseRelay(true, 'p.relay'), true);
  assert.equal(parseRelay(false, 'p.relay'), false);
  assert.equal(parseRelay(undefined, 'p.relay'), undefined);
});

test('parseRelay parses and normalizes the object form', () => {
  const r = parseRelay(
    {
      enabled: true,
      agentName: ' granola ',
      channels: ['#eng', 'eng', 'ops'],
      inbox: ['@self'],
      futureDeliveryPolicy: { durability: 'persisted' }
    },
    'p.relay'
  );
  assert.deepEqual(r, {
    enabled: true,
    agentName: 'granola',
    channels: ['#eng', 'eng', 'ops'],
    inbox: ['@self'],
    futureDeliveryPolicy: { durability: 'persisted' }
  });
});

test('parsePersonaSpec forwards extensions across other open record families', () => {
  const spec = parsePersonaSpec(
    {
      id: 'extension-safe',
      intent: 'documentation',
      description: 'x',
      onEvent: './agent.ts',
      skills: [{
        id: 'docs',
        source: 'https://example.com/docs',
        description: 'read docs',
        futureSkillPolicy: 'verified'
      }],
      harnessSettings: {
        reasoning: 'medium',
        timeoutSeconds: 300,
        futureHarnessPolicy: { tenancy: 'workspace' }
      }
    },
    'documentation'
  );
  assert.deepEqual(spec.harnessSettings.futureHarnessPolicy, { tenancy: 'workspace' });
  assert.equal(spec.skills[0]?.futureSkillPolicy, 'verified');
});

test('parseRelay rejects malformed shapes', () => {
  assert.throws(() => parseRelay(42, 'p.relay'), /must be a boolean or an object/);
  assert.throws(() => parseRelay({ enabled: 'yes' }, 'p.relay'), /enabled must be a boolean/);
  assert.throws(() => parseRelay({ agentName: '  ' }, 'p.relay'), /agentName must be a non-empty/);
  assert.throws(() => parseRelay({ channels: 'eng' }, 'p.relay'), /channels must be an array/);
  assert.throws(() => parseRelay({ inbox: [''] }, 'p.relay'), /inbox\[0\] must be a non-empty/);
});

test('parsePersonaSpec threads the relay field through', () => {
  const spec = parsePersonaSpec(
    {
      id: 'granola-prospect',
      intent: 'relay-orchestrator',
      description: 'x',
      skills: [],
      harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
      onEvent: './agent.ts',
      relay: { channels: ['eng'] }
    },
    'relay-orchestrator'
  );
  assert.deepEqual(spec.relay, { channels: ['eng'] });
});

test('resolvePersonaRelayMcp returns disabled when off', () => {
  assert.equal(resolvePersonaRelayMcp(undefined, {}).kind, 'disabled');
  assert.equal(resolvePersonaRelayMcp(false, { RELAY_API_KEY: 'k' }).kind, 'disabled');
  assert.equal(resolvePersonaRelayMcp({ enabled: false }, { RELAY_API_KEY: 'k' }).kind, 'disabled');
});

test('resolvePersonaRelayMcp flags a missing secret rather than dropping silently', () => {
  const r = resolvePersonaRelayMcp(true, {}, 'granola');
  assert.equal(r.kind, 'missing-secret');
  if (r.kind === 'missing-secret') assert.match(r.reason, /RELAY_API_KEY/);
});

test('resolvePersonaRelayMcp merges declared intent with env secrets', () => {
  const r = resolvePersonaRelayMcp(
    { channels: ['eng'], defaultWorkspace: 'acme' },
    { RELAY_API_KEY: 'sk-1', RELAY_BASE_URL: 'https://relay.example' },
    'granola-prospect'
  );
  assert.equal(r.kind, 'ready');
  if (r.kind !== 'ready') return;
  assert.deepEqual(r.config, {
    apiKey: 'sk-1',
    agentName: 'granola-prospect', // fell back to persona id
    baseUrl: 'https://relay.example',
    defaultWorkspace: 'acme' // declared value wins
  });
});

test('resolvePersonaRelayMcp: explicit agentName and env workspace', () => {
  const r = resolvePersonaRelayMcp(
    { agentName: 'reviewer' },
    { RELAY_API_KEY: 'sk-2', RELAY_DEFAULT_WORKSPACE: 'ws-env' }
  );
  assert.equal(r.kind, 'ready');
  if (r.kind !== 'ready') return;
  assert.equal(r.config.agentName, 'reviewer');
  assert.equal(r.config.defaultWorkspace, 'ws-env');
});
