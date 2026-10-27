import test from 'node:test';
import assert from 'node:assert/strict';
import { CLOUD_ENVELOPE_FIELDS } from './envelope-fields.cloud.js';
import { RAW_GATEWAY_ENVELOPE_FIELDS, type RawGatewayEnvelope } from './shim.js';
import { envelopeToAgentEvent } from './to-agent-event.js';

/**
 * Cross-repo envelope contract test (workforce#189): every field cloud's
 * buildEnvelope can emit must be a documented RawGatewayEnvelope field.
 * Cloud's side pins buildEnvelope's output to ENVELOPE_FIELDS; this side
 * pins the type against the checked-in copy. Drift fails CI on whichever
 * side moved first.
 */

test('every cloud envelope field is documented on RawGatewayEnvelope', () => {
  const documented = new Set<string>(RAW_GATEWAY_ENVELOPE_FIELDS);
  const cloudFields = [...CLOUD_ENVELOPE_FIELDS.always, ...CLOUD_ENVELOPE_FIELDS.optional];
  const missing = cloudFields.filter((field) => !documented.has(field));
  assert.deepEqual(
    missing,
    [],
    `cloud's buildEnvelope emits field(s) not documented on RawGatewayEnvelope: ${missing.join(', ')}. ` +
      'Add them to the type + RAW_GATEWAY_ENVELOPE_FIELDS in shim.ts (and confirm ' +
      'envelope-fields.cloud.ts matches cloud ENVELOPE_FIELDS).',
  );
});

test('cloud field lists are disjoint and non-empty (copy sanity)', () => {
  const always = new Set<string>(CLOUD_ENVELOPE_FIELDS.always);
  assert.ok(always.size > 0 && CLOUD_ENVELOPE_FIELDS.optional.length > 0);
  for (const field of CLOUD_ENVELOPE_FIELDS.optional) {
    assert.ok(!always.has(field), `field "${field}" is in both always and optional`);
  }
});

test('a full cloud-shaped envelope (all contract fields) shims without loss of dispatch', async () => {
  // An exported fixture from `runs export` carries the cloud-only fields;
  // shimEnvelope must still dispatch it (unknown-to-dispatch fields are
  // simply not consumed — replay fidelity comes from `resource`).
  const envelope: RawGatewayEnvelope = {
    id: 'evt_1',
    workspace: 'ws-1',
    type: 'github.pull_request.opened',
    occurredAt: '2026-06-04T09:00:00.000Z',
    attempt: 1,
    name: '',
    cron: '',
    provider: 'github',
    eventType: 'pull_request.opened',
    deliveryId: 'gh-123',
    paths: ['/github/repos/a/b/pulls/1'],
    resource: { action: 'opened' },
    summary: { title: 'x' },
    resumeContext: { phase: 2 },
  };
  const event = envelopeToAgentEvent(envelope);
  assert.ok(event);
  if (!event) return;
  assert.equal(event.type, 'github.pull_request.opened');
  assert.equal(event.resource.provider, 'github');
  const full = await event.expand('full');
  assert.deepEqual(full.data, { action: 'opened' });
});
