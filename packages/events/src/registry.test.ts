import assert from 'node:assert/strict';
import test from 'node:test';
import addFormatsModule from 'ajv-formats';
import { Ajv2020 } from 'ajv/dist/2020.js';
import {
  decodeEventFrame,
  EVENT_CONTRACTS,
  EVENT_CONTRACT_JSON_SCHEMAS,
  parseEventFrame,
  redactEventValue,
  safeParseEventFrame
} from './index.js';

test('every registry entry exports schema and validating example fixtures', () => {
  assert.deepEqual(EVENT_CONTRACTS.map((entry) => entry.id), [
    'startup',
    'cron.tick',
    'github.issues.labeled',
    'github.pull_request.opened',
    'slack.message.created',
    'linear.issue.created',
    'composio.trigger.message',
    'relaycast.message'
  ]);
  for (const contract of EVENT_CONTRACTS) {
    assert.ok(EVENT_CONTRACT_JSON_SCHEMAS[`${contract.id}@${contract.version}`]);
    assert.ok(contract.fixtureExamples.length > 0);
    for (const fixture of contract.fixtureExamples) {
      assert.equal(parseEventFrame(fixture), fixture);
      assert.deepEqual(contract.validate(fixture), { valid: true, errors: [] });
    }
  }
});

test('Composio V3 trigger contract validates the canonical envelope and identity coordinates', () => {
  const contract = EVENT_CONTRACTS.find((entry) => entry.id === 'composio.trigger.message');
  assert.ok(contract);
  const fixture = contract.fixtureExamples[0];
  const payload = fixture.payload as Record<string, unknown>;
  const metadata = payload.metadata as Record<string, unknown>;

  assert.equal(contract.version, 1);
  assert.equal(contract.provider, 'composio');
  assert.equal(contract.trigger, 'trigger.message');
  assert.equal(contract.resourceKind, 'composio.trigger');
  assert.equal(fixture.resource.id, metadata.trigger_id);
  assert.equal(fixture.resource.path, `/composio/triggers/${encodeURIComponent(String(metadata.trigger_id))}`);
  assert.equal(fixture.occurredAt, payload.timestamp);
  assert.equal(fixture.delivery?.id, payload.id);
  assert.equal(fixture.delivery?.dedupeKey, payload.id);
  assert.deepEqual(contract.validate(fixture), { valid: true, errors: [] });

  assert.equal(contract.validate({ ...fixture, payload: { ...payload, id: '' } }).valid, false);
  assert.equal(contract.validate({ ...fixture, payload: { ...payload, type: 'composio.trigger.other' } }).valid, false);
  assert.equal(contract.validate({
    ...fixture,
    payload: { ...payload, metadata: { ...metadata, trigger_id: undefined } }
  }).valid, false);
  assert.equal(contract.validate({ ...fixture, payload: { ...payload, data: [] } }).valid, false);
  assert.equal(contract.validate({ ...fixture, payload: { ...payload, timestamp: 'not-a-timestamp' } }).valid, false);

  const forwardCompatible = {
    ...fixture,
    payload: {
      ...payload,
      metadata: { ...metadata, future_metadata: { retained: true } },
      data: { future_provider_field: true },
      future_envelope_field: 'retained'
    }
  };
  assert.deepEqual(contract.validate(forwardCompatible), { valid: true, errors: [] });
});

test('all exported contract schemas register together without identifier collisions', () => {
  const ajv = new Ajv2020({ strict: true });
  (addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020)(ajv);
  for (const schema of Object.values(EVENT_CONTRACT_JSON_SCHEMAS)) ajv.addSchema(schema);
});

test('known schema versions reject unknown top-level fields and preserve extensions', () => {
  const fixture = EVENT_CONTRACTS[1].fixtureExamples[0];
  assert.equal(safeParseEventFrame({ ...fixture, surprise: true }).success, false);
  const extended = { ...fixture, extensions: { futureCapability: { enabled: true } } };
  assert.deepEqual(parseEventFrame(extended).extensions, { futureCapability: { enabled: true } });
});

test('legacy gateway envelopes decode with visible compatibility metadata', () => {
  const decoded = decodeEventFrame({
    id: 'evt_legacy',
    workspace: 'ws_1',
    type: 'github.issue.labeled',
    occurredAt: '2026-07-15T09:00:00.000Z',
    attempt: 2,
    provider: 'github',
    deliveryId: 'delivery_1',
    paths: ['/github/repos/acme/app/issues/42.json'],
    resource: { action: 'labeled', issue: { number: 42 } },
    summary: { title: 'Issue labeled' },
    resumeContext: { phase: 2 },
    vendorFutureField: { retained: true }
  });
  assert.equal(decoded.frame.type, 'github.issues.labeled');
  assert.equal(decoded.frame.contractVersion, 1);
  assert.deepEqual(decoded.frame.payload, { action: 'labeled', issue: { number: 42 } });
  assert.equal(decoded.compatibility?.source, 'legacy-raw-gateway-envelope');
  assert.deepEqual(decoded.compatibility?.aliasesApplied, ['github.issue.labeled -> github.issues.labeled']);
  assert.deepEqual(decoded.frame.extensions?.vendorFutureField, { retained: true });
  assert.deepEqual(decoded.frame.extensions?.resumeContext, { phase: 2 });
});

test('legacy cron and relaycast envelopes retain their specialized coordinates', () => {
  const cron = decodeEventFrame({ id: 'cron_1', workspace: 'ws', type: 'cron.tick', occurredAt: '2026-07-15T09:00:00Z', name: 'scan', cron: '0 9 * * *' });
  assert.deepEqual(cron.frame.schedule, { name: 'scan', cron: '0 9 * * *' });
  assert.equal(cron.frame.resource.id, 'scan');

  const relay = decodeEventFrame({ id: 'msg_evt', workspace: 'ws', type: 'relaycast.message', occurredAt: '2026-07-15T09:00:00Z', channel: 'general', messageId: 'm1', threadId: 't1', resource: { text: 'hello' } });
  assert.deepEqual(relay.frame.message, { channel: 'general', messageId: 'm1', threadId: 't1' });
  assert.equal(relay.frame.resource.kind, 'relaycast.message');
});

test('legacy startup remains compatible and resource lookalikes retain provider data', () => {
  const startup = decodeEventFrame({ id: 'evt_boot', workspace: 'ws', type: 'startup', occurredAt: '2026-07-15T09:00:00Z' });
  assert.equal(startup.frame.type, 'startup');
  assert.equal(startup.frame.resource.kind, 'runtime.startup');

  const github = decodeEventFrame({
    id: 'evt_resource',
    workspace: 'ws',
    type: 'github.issues.labeled',
    occurredAt: '2026-07-15T09:00:00Z',
    resource: { path: '/provider/path', kind: 'github.issue', id: '42', provider: 'github', action: 'labeled' }
  });
  assert.deepEqual(github.frame.payload, { path: '/provider/path', kind: 'github.issue', id: '42', provider: 'github', action: 'labeled' });
  assert.equal(github.frame.resource.path.includes('//'), false);
});

test('legacy extension copying is prototype-safe and preserves compatibility collisions', () => {
  const legacy = JSON.parse('{"id":"evt_proto","workspace":"ws","type":"startup","occurredAt":"2026-07-15T09:00:00Z","__proto__":{"polluted":true},"compatibility":{"vendor":"original"}}');
  const decoded = decodeEventFrame(legacy);
  assert.equal(Object.prototype.hasOwnProperty.call(decoded.frame.extensions, '__proto__'), true);
  assert.deepEqual(decoded.frame.extensions?.__proto__, { polluted: true });
  assert.deepEqual(decoded.compatibility?.originalCompatibility, { vendor: 'original' });
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('schema-driven validation rejects malformed timestamps and summary fields', () => {
  const fixture = EVENT_CONTRACTS[0].fixtureExamples[0];
  assert.equal(safeParseEventFrame({ ...fixture, occurredAt: 'July 15, 2026' }).success, false);
  assert.equal(safeParseEventFrame({ ...fixture, summary: { title: 42 } }).success, false);
  assert.equal(safeParseEventFrame({ ...fixture, schedule: { name: 'scan', scheduledFor: '2026-02-30T00:00:00Z' } }).success, false);
});

test('redaction is recursive, immutable, and handles bearer strings', () => {
  const input = { token: 'secret', nested: [{ authorization: 'Bearer abc.def', text: 'Bearer abc.def' }] };
  const output = redactEventValue(input);
  assert.deepEqual(output, { token: '[REDACTED]', nested: [{ authorization: '[REDACTED]', text: '[REDACTED]' }] });
  assert.equal(input.token, 'secret');
});

test('redaction preserves prototype-looking data safely and treats global matchers statelessly', () => {
  const input = JSON.parse('{"__proto__":{"safe":true},"first":"one","second":"two"}');
  const output = redactEventValue(input, { additionalSensitiveKeys: [/first|second/g] });
  assert.equal(Object.prototype.hasOwnProperty.call(output, '__proto__'), true);
  assert.deepEqual(output.__proto__, { safe: true });
  assert.equal(output.first, '[REDACTED]');
  assert.equal(output.second, '[REDACTED]');
  assert.equal(({} as { safe?: boolean }).safe, undefined);

  const date = new Date('2026-07-15T09:00:00Z');
  assert.equal(redactEventValue(date), date);
});
