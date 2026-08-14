import test from 'node:test';
import assert from 'node:assert/strict';
import { isCronTickEvent, isRelaycastMessageEvent, isStartupEvent } from '@agent-relay/events';
import { envelopeToAgentEvent } from './to-agent-event.js';

test('envelopeToAgentEvent maps a cron.tick envelope to a CronTickEvent', () => {
  const ev = envelopeToAgentEvent({
    id: 'evt-1',
    workspace: 'ws-acme',
    type: 'cron.tick',
    occurredAt: '2026-05-12T09:00:00Z',
    name: 'weekly',
    cron: '0 9 * * 6'
  });
  assert.ok(ev);
  assert.ok(isCronTickEvent(ev));
  if (!isCronTickEvent(ev)) return;
  assert.equal(ev.type, 'cron.tick');
  assert.equal(ev.schedule, '0 9 * * 6');
  assert.equal(ev.workspace, 'ws-acme');
  assert.equal(ev.id, 'evt-1');
  assert.equal(ev.attempt, 1);
});

test('envelopeToAgentEvent maps a startup envelope to a StartupEvent', () => {
  const ev = envelopeToAgentEvent({
    id: 'evt-boot',
    workspace: 'ws-acme',
    type: 'startup',
    occurredAt: '2026-05-12T08:00:00Z'
  });
  assert.ok(ev);
  assert.ok(isStartupEvent(ev));
});

test('envelopeToAgentEvent maps a provider envelope, deriving resource + kind', () => {
  const ev = envelopeToAgentEvent({
    id: 'evt-7',
    workspace: 'ws-acme',
    type: 'github.pull_request.opened',
    occurredAt: '2026-05-12T10:00:00Z',
    attempt: 2,
    provider: 'github',
    deliveryId: 'gh-delivery-99',
    paths: ['/github/pull_requests/42'],
    resource: { pr: { number: 42 } },
    summary: { title: 'Add deploy' }
  });
  assert.ok(ev);
  assert.equal(ev.type, 'github.pull_request.opened');
  assert.equal(ev.attempt, 2);
  assert.equal(ev.resource.provider, 'github');
  assert.equal(ev.resource.kind, 'github.pull_request');
  assert.equal(ev.resource.id, 'gh-delivery-99');
  assert.equal(ev.resource.path, '/github/pull_requests/42');
  assert.deepEqual(ev.summary, { title: 'Add deploy' });
});

test('envelopeToAgentEvent exposes the cloud payload via expand("full")', async () => {
  const ev = envelopeToAgentEvent({
    id: 'evt-8',
    workspace: 'ws-acme',
    type: 'linear.issue.created',
    occurredAt: '2026-05-12T10:00:00Z',
    resource: { issue: { identifier: 'ENG-1' } }
  });
  assert.ok(ev);
  const full = await ev.expand('full');
  assert.equal(full.level, 'full');
  assert.deepEqual(full.data, { issue: { identifier: 'ENG-1' } });
});

test('envelopeToAgentEvent reads first-class channel/messageId/threadId (Unit B)', () => {
  // Cloud now surfaces these top-level on the envelope; the mapper should
  // prefer them over the nested `resource` copy.
  const ev = envelopeToAgentEvent({
    id: 'evt-top',
    workspace: 'ws-acme',
    type: 'relaycast.message',
    occurredAt: '2026-05-12T11:00:00Z',
    channel: 'eng',
    messageId: 'm-top',
    threadId: 't-top',
    resource: { channel: 'stale', messageId: 'stale', text: 'hi' }
  });
  assert.ok(ev);
  assert.ok(isRelaycastMessageEvent(ev));
  if (!isRelaycastMessageEvent(ev)) return;
  assert.equal(ev.channel, 'eng');
  assert.equal(ev.messageId, 'm-top');
  assert.equal(ev.threadId, 't-top');
});

test('envelopeToAgentEvent maps a relaycast.message envelope (fields ride in resource)', () => {
  // Shape the proactive-runtime HTTP gateway delivers: the relay-native
  // envelope is nested under `resource` (resource: payload.resource ?? payload).
  const ev = envelopeToAgentEvent({
    id: 'evt-msg',
    workspace: 'ws-acme',
    type: 'relaycast.message',
    occurredAt: '2026-05-12T11:00:00Z',
    resource: {
      channel: 'eng',
      messageId: 'm-123',
      threadId: 't-9',
      text: 'can you take a look?'
    }
  });
  assert.ok(ev);
  assert.ok(isRelaycastMessageEvent(ev));
  if (!isRelaycastMessageEvent(ev)) return;
  assert.equal(ev.type, 'relaycast.message');
  assert.equal(ev.channel, 'eng');
  assert.equal(ev.messageId, 'm-123');
  assert.equal(ev.threadId, 't-9');
  assert.equal(ev.resource.provider, 'relaycast');
});

test('envelopeToAgentEvent maps a user_reply continuation to a relaycast message', () => {
  const ev = envelopeToAgentEvent({
    id: 'evt-reply',
    workspace: 'ws-acme',
    type: 'user_reply',
    occurredAt: '2026-05-12T11:05:00Z',
    resource: { message: { id: 'm-456', text: 'yes, go ahead' } },
    resumeContext: { threadId: 't-9' }
  });
  assert.ok(ev);
  assert.ok(isRelaycastMessageEvent(ev));
  if (!isRelaycastMessageEvent(ev)) return;
  assert.equal(ev.messageId, 'm-456');
  assert.equal(ev.threadId, 't-9');
});

test('envelopeToAgentEvent drops malformed envelopes', () => {
  assert.equal(envelopeToAgentEvent({ id: '', workspace: 'ws', type: 'cron.tick' } as never), null);
  assert.equal(envelopeToAgentEvent({ id: 'x', workspace: '', type: 'cron.tick' } as never), null);
  assert.equal(envelopeToAgentEvent({ id: 'x', workspace: 'ws', type: '' } as never), null);
  // provider type with a valid source but no event-name suffix
  assert.equal(envelopeToAgentEvent({ id: 'x', workspace: 'ws', type: 'github.' } as never), null);
});

test('an app-triggered cron.tick carries its payload through to the handler', async () => {
  // Cloud reuses the cron.tick envelope for an app trigger: a customer's
  // product POSTs JSON to /deployments/<agent>/trigger and cloud puts it in
  // the envelope's `resource`. Returning the bare cron event dropped it — the
  // envelope had the payload, the handler saw a contentless tick.
  const ev = envelopeToAgentEvent({
    id: 'app:usage-spike-acme-1',
    workspace: 'ws-acme',
    type: 'cron.tick',
    occurredAt: '2026-08-14T21:43:00Z',
    name: 'manual',
    cron: '',
    resource: {
      source: 'app.trigger',
      payload: { accountId: 'acme', reason: 'usage_spike' }
    }
  } as never);

  assert.ok(ev);
  // Still a cron tick: identity, schedule fields and the synthetic /_cron
  // resource are unchanged, so nothing that keys off those regresses.
  assert.ok(isCronTickEvent(ev));
  if (!isCronTickEvent(ev)) return;
  assert.equal(ev.id, 'app:usage-spike-acme-1');
  assert.equal(ev.resource.kind, 'cron.tick');
  assert.ok(ev.resource.path.startsWith('/_cron/'));

  // …and the payload is now reachable, the same way relaycast surfaces its own.
  const full = await ev.expand('full');
  assert.deepEqual(full.data, {
    source: 'app.trigger',
    payload: { accountId: 'acme', reason: 'usage_spike' }
  });
});

test('a scheduled cron.tick carrying a canonical resource is still payload-less', async () => {
  // The legacy decoder builds `{path, kind, id, provider}` for cron envelopes
  // and the canonical cron fixture uses exactly that shape. Treating any object
  // resource as a payload would make expansion start RESOLVING for ordinary
  // schedule firings, so a handler reading expansion success as "this run
  // carried input" would see every clock tick as payload-bearing.
  const ev = envelopeToAgentEvent({
    id: 'evt-canonical',
    workspace: 'ws-acme',
    type: 'cron.tick',
    occurredAt: '2026-07-15T09:00:00Z',
    name: 'scan',
    cron: '0 9 * * *',
    resource: { path: '/cron/schedules/scan', kind: 'cron.schedule', id: 'scan', provider: 'cron' }
  } as never);

  assert.ok(ev);
  assert.ok(isCronTickEvent(ev));
  if (!isCronTickEvent(ev)) return;
  await assert.rejects(() => ev.expand('full'), /no gateway loader was configured/u);
});

test('a scheduled cron.tick without a resource is unchanged', async () => {
  const ev = envelopeToAgentEvent({
    id: 'evt-plain',
    workspace: 'ws-acme',
    type: 'cron.tick',
    occurredAt: '2026-08-14T07:00:00Z',
    name: 'credential-canary',
    cron: '0 7 * * 1'
  });

  assert.ok(ev);
  assert.ok(isCronTickEvent(ev));
  if (!isCronTickEvent(ev)) return;
  assert.equal(ev.schedule, '0 7 * * 1');
  // No resource on the envelope means no loader is wired, so expansion still
  // rejects exactly as it did before this change — the clock-tick path must
  // not start inventing a payload. (This is also why a handler reading
  // `expand('full')` has to guard it.)
  await assert.rejects(() => ev.expand('full'), /no gateway loader was configured/u);
});
