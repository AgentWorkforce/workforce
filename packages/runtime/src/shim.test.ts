import test from 'node:test';
import assert from 'node:assert/strict';
import { shimEnvelope } from './shim.js';
import { handler, isWorkforceHandler } from './handler.js';

test('shimEnvelope translates a cron.tick envelope', () => {
  const ev = shimEnvelope({
    id: 'evt-1',
    workspace: 'ws-acme',
    type: 'cron.tick',
    occurredAt: '2026-05-12T09:00:00Z',
    name: 'weekly',
    cron: '0 9 * * 6'
  });
  assert.ok(ev);
  assert.equal(ev.source, 'cron');
  if (ev.source !== 'cron') return;
  assert.equal(ev.name, 'weekly');
  assert.equal(ev.cron, '0 9 * * 6');
  assert.equal(ev.workspaceId, 'ws-acme');
  assert.equal(ev.attempt, 1);
});

test('shimEnvelope translates a provider envelope with summary', () => {
  const ev = shimEnvelope({
    id: 'evt-7',
    workspace: 'ws-acme',
    type: 'github.pull_request.opened',
    occurredAt: '2026-05-12T10:00:00Z',
    attempt: 2,
    resource: { pr: { number: 42 } },
    summary: { title: 'Add deploy', actor: 'kgnt' }
  });
  assert.ok(ev);
  if (ev.source === 'cron') {
    assert.fail('expected provider event, got cron');
  }
  assert.equal(ev.source, 'github');
  assert.equal(ev.type, 'pull_request.opened');
  assert.equal(ev.attempt, 2);
  assert.deepEqual(ev.summary, { title: 'Add deploy', actor: 'kgnt' });
});

test('shimEnvelope falls back to attempt=1 and a generated occurredAt when missing', () => {
  const before = Date.now();
  const ev = shimEnvelope({
    id: 'evt-x',
    workspace: 'ws-a',
    type: 'linear.issue.created',
    occurredAt: undefined as unknown as string
  });
  assert.ok(ev);
  if (ev.source === 'cron') return;
  assert.equal(ev.attempt, 1);
  const occurredAtMs = Date.parse(ev.occurredAt);
  assert.ok(Number.isFinite(occurredAtMs));
  assert.ok(occurredAtMs >= before - 1000);
});

test('shimEnvelope returns null for unknown sources and malformed envelopes', () => {
  assert.equal(
    shimEnvelope({ id: 'e', workspace: 'w', type: 'mystery.event.fired', occurredAt: 'x' }),
    null
  );
  assert.equal(shimEnvelope({ id: '', workspace: 'w', type: 'cron.tick', occurredAt: 'x' }), null);
  assert.equal(shimEnvelope({ id: 'e', workspace: '', type: 'cron.tick', occurredAt: 'x' }), null);
  assert.equal(shimEnvelope({ id: 'e', workspace: 'w', type: '', occurredAt: 'x' }), null);
});

test('shimEnvelope returns null when provider event has no event-name suffix', () => {
  assert.equal(
    shimEnvelope({ id: 'e', workspace: 'w', type: 'github.', occurredAt: 'x' }),
    null
  );
});

test('handler() brands a function and round-trips identity', () => {
  let called = false;
  const fn = handler(async () => {
    called = true;
  });
  assert.equal(typeof fn, 'function');
  assert.equal(isWorkforceHandler(fn), true);
  assert.equal(isWorkforceHandler(() => {}), false);
  assert.equal(isWorkforceHandler('not a fn'), false);
  // Marker is non-enumerable so persona authors don't see it in iteration.
  assert.equal(Object.keys(fn).length, 0);
  // Identity: handler(f) returns the same callable f.
  fn({} as never, {} as never);
  assert.equal(called, true);
});

test('handler() rejects non-function inputs', () => {
  // @ts-expect-error intentional misuse
  assert.throws(() => handler('nope'), /expects a function/);
  // @ts-expect-error intentional misuse
  assert.throws(() => handler(undefined), /expects a function/);
});
