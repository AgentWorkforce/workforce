import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeCronFire, workforceEventType } from './cron.js';

test('normalizeCronFire accepts a v4 cron.tick and prefers scheduledFor', () => {
  const fire = normalizeCronFire({
    type: 'cron.tick',
    scheduledFor: '2026-07-15T06:00:00.000Z',
    occurredAt: '2026-07-15T06:00:03.000Z',
    resource: { id: 'daily' }
  });

  assert.deepEqual(fire, {
    firedAt: new Date('2026-07-15T06:00:00.000Z'),
    scheduleName: 'daily'
  });
});

test('normalizeCronFire accepts a v3 cron event and reads its name', () => {
  const fire = normalizeCronFire({
    source: 'cron',
    occurredAt: '2026-07-15T06:00:03.000Z',
    name: 'legacy-daily'
  });

  assert.deepEqual(fire, {
    firedAt: new Date('2026-07-15T06:00:03.000Z'),
    scheduleName: 'legacy-daily'
  });
});

test('normalizeCronFire falls back to now and does not require a schedule name', () => {
  const before = Date.now();
  const fire = normalizeCronFire({ type: 'cron.tick' });
  const after = Date.now();

  assert.ok(fire);
  assert.equal(fire.scheduleName, undefined);
  assert.ok(fire.firedAt.getTime() >= before);
  assert.ok(fire.firedAt.getTime() <= after);
});

test('normalizeCronFire rejects non-cron and malformed events', () => {
  assert.equal(normalizeCronFire({ type: 'github.pull_request.opened' }), null);
  assert.equal(normalizeCronFire(null), null);
  assert.equal(normalizeCronFire('cron.tick'), null);
});

test('workforceEventType prefers type, then source, then unknown', () => {
  assert.equal(workforceEventType({ type: 'cron.tick', source: 'cron' }), 'cron.tick');
  assert.equal(workforceEventType({ source: 'cron' }), 'cron');
  assert.equal(workforceEventType({ type: 42, source: false }), 'unknown');
  assert.equal(workforceEventType(undefined), 'unknown');
});
