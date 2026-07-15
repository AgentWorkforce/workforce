import assert from 'node:assert/strict';
import test from 'node:test';
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
    'cron.tick',
    'github.issues.labeled',
    'github.pull_request.opened',
    'slack.message.created',
    'linear.issue.created',
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

test('redaction is recursive, immutable, and handles bearer strings', () => {
  const input = { token: 'secret', nested: [{ authorization: 'Bearer abc.def', text: 'Bearer abc.def' }] };
  const output = redactEventValue(input);
  assert.deepEqual(output, { token: '[REDACTED]', nested: [{ authorization: '[REDACTED]', text: '[REDACTED]' }] });
  assert.equal(input.token, 'secret');
});
