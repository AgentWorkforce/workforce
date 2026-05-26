import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AGENT_MANIFEST_SCHEMA,
  DEFAULT_INTEGRATION_PLATFORM_SECRETS,
  deriveDeployRequirements,
  parseAgentManifest,
  type AgentManifest
} from './manifest.js';
import type { PersonaSpec } from './types.js';

function persona(overrides: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    id: 'p',
    intent: 'documentation',
    tags: ['documentation'],
    description: 'd',
    skills: [],
    harness: 'claude',
    model: 'anthropic/claude-3-5-sonnet',
    systemPrompt: 'be helpful',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
    ...overrides
  };
}

// ---- parseAgentManifest --------------------------------------------------

test('parseAgentManifest accepts a minimal persona manifest', () => {
  const m = parseAgentManifest({ schema: AGENT_MANIFEST_SCHEMA, persona: './persona.json' });
  assert.equal(m.schema, AGENT_MANIFEST_SCHEMA);
  assert.equal(m.persona, './persona.json');
  assert.equal(m.template, undefined);
});

test('parseAgentManifest accepts a template manifest', () => {
  const m = parseAgentManifest({ schema: AGENT_MANIFEST_SCHEMA, template: 'cloud-small-issue-codex' });
  assert.equal(m.template, 'cloud-small-issue-codex');
  assert.equal(m.persona, undefined);
});

test('parseAgentManifest rejects a wrong/missing schema', () => {
  assert.throws(() => parseAgentManifest({ persona: './p.json' }), /schema must be/);
  assert.throws(() => parseAgentManifest({ schema: 'v2', persona: './p.json' }), /schema must be/);
});

test('parseAgentManifest requires exactly one of persona|template', () => {
  assert.throws(() => parseAgentManifest({ schema: AGENT_MANIFEST_SCHEMA }), /exactly one/);
  assert.throws(
    () => parseAgentManifest({ schema: AGENT_MANIFEST_SCHEMA, persona: './p.json', template: 't' }),
    /exactly one/
  );
});

test('parseAgentManifest validates nested integration/secret/input shapes', () => {
  const base = { schema: AGENT_MANIFEST_SCHEMA, persona: './p.json' };
  assert.throws(() => parseAgentManifest({ ...base, integrations: { github: { required: 'yes' } } }), /required must be a boolean/);
  assert.throws(() => parseAgentManifest({ ...base, integrations: { github: { scope: { repo: 1 } } } }), /scope\.repo must be a string/);
  assert.throws(() => parseAgentManifest({ ...base, secrets: { NangoSecretKey: {} } }), /required must be a boolean/);
  assert.throws(() => parseAgentManifest({ ...base, inputs: { task: 5 } }), /inputs\.task must be a string/);
});

test('parseAgentManifest round-trips a full manifest', () => {
  const input = {
    schema: AGENT_MANIFEST_SCHEMA,
    name: 'issue-bot',
    persona: './persona.json',
    workspace: 'acme',
    integrations: { github: { required: true, reason: 'triage issues', scope: { repo: 'acme/web' } } },
    secrets: { NangoSecretKey: { required: true, reason: 'gh creds', provider: 'github' } },
    inputs: { greeting: 'hi' }
  } satisfies Record<string, unknown>;
  const m = parseAgentManifest(input);
  assert.equal(m.name, 'issue-bot');
  assert.equal(m.integrations?.github.scope?.repo, 'acme/web');
  assert.equal(m.secrets?.NangoSecretKey.required, true);
  assert.equal(m.inputs?.greeting, 'hi');
});

// ---- deriveDeployRequirements -------------------------------------------

test('integrations: union of persona + manifest, required defaults true', () => {
  const p = persona({
    integrations: {
      github: { triggers: [{ on: 'issues.opened' }, { on: 'issues.edited' }] }
    }
  });
  const m: AgentManifest = { schema: AGENT_MANIFEST_SCHEMA, persona: './p.json' };
  const req = deriveDeployRequirements(m, p);
  assert.equal(req.integrations.length, 1);
  assert.equal(req.integrations[0].provider, 'github');
  assert.equal(req.integrations[0].required, true);
  assert.deepEqual(req.integrations[0].triggers, ['issues.opened', 'issues.edited']);
});

test('integrations: manifest can mark a provider optional + add reason', () => {
  const p = persona({ integrations: { slack: { triggers: [{ on: 'message.created' }] } } });
  const m: AgentManifest = {
    schema: AGENT_MANIFEST_SCHEMA,
    persona: './p.json',
    integrations: { slack: { required: false, reason: 'optional notifications' } }
  };
  const req = deriveDeployRequirements(m, p);
  assert.equal(req.integrations[0].required, false);
  assert.equal(req.integrations[0].reason, 'optional notifications');
});

test('inputs: only prompt for required inputs (no default, not optional, not pre-filled)', () => {
  const p = persona({
    inputs: {
      mustAsk: { description: 'needed' },
      hasDefault: { default: 'x' },
      isOptional: { optional: true },
      prefilled: { description: 'will be supplied by manifest' }
    }
  });
  const m: AgentManifest = { schema: AGENT_MANIFEST_SCHEMA, persona: './p.json', inputs: { prefilled: 'v' } };
  const req = deriveDeployRequirements(m, p);
  assert.deepEqual(req.inputs.map((i) => i.name), ['mustAsk']);
  assert.equal(req.inputs[0].description, 'needed');
});

test('platformSecrets: empty for shared-platform (Layer A) deploy', () => {
  const p = persona({ integrations: { github: { triggers: [{ on: 'issues.opened' }] } } });
  const m: AgentManifest = { schema: AGENT_MANIFEST_SCHEMA, persona: './p.json' };
  const req = deriveDeployRequirements(m, p);
  assert.deepEqual(req.platformSecrets, []);
});

test('platformSecrets: isolated mode maps providers → Nango + WebRelayauth', () => {
  const p = persona({ integrations: { github: { triggers: [{ on: 'issues.opened' }] } } });
  const m: AgentManifest = { schema: AGENT_MANIFEST_SCHEMA, persona: './p.json' };
  const req = deriveDeployRequirements(m, p, { isolated: true });
  const names = req.platformSecrets.map((s) => s.name);
  assert.deepEqual(names, ['NangoSecretKey', 'WebRelayauthApiKey']);
  assert.deepEqual([...DEFAULT_INTEGRATION_PLATFORM_SECRETS.github], ['NangoSecretKey', 'WebRelayauthApiKey']);
});

test('platformSecrets: manifest-declared secret overrides the default mapping entry', () => {
  const p = persona({ integrations: { github: { triggers: [{ on: 'issues.opened' }] } } });
  const m: AgentManifest = {
    schema: AGENT_MANIFEST_SCHEMA,
    persona: './p.json',
    secrets: { NangoSecretKey: { required: false, reason: 'stubbed in this test stage' } }
  };
  const req = deriveDeployRequirements(m, p, { isolated: true });
  const nango = req.platformSecrets.find((s) => s.name === 'NangoSecretKey');
  assert.equal(nango?.required, false);
  assert.equal(nango?.reason, 'stubbed in this test stage');
  // WebRelayauth still contributed by the default mapping.
  assert.ok(req.platformSecrets.some((s) => s.name === 'WebRelayauthApiKey'));
});
