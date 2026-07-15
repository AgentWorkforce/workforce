import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_EFFECT_POLICY_DEFAULTS,
  resolveLocalEffectPolicy,
  type RunRecordV2
} from './run-contracts.js';

test('local EffectPolicyV1 defaults are fixture/stub/preview safe', () => {
  assert.deepEqual(LOCAL_EFFECT_POLICY_DEFAULTS, {
    reads: 'fixtures',
    writes: 'preview',
    model: 'stub',
    shell: 'simulate',
    compose: 'preview',
    allowedHttp: []
  });
});

test('local effect policy cannot be escalated to live writes, shell, or compose', () => {
  assert.deepEqual(resolveLocalEffectPolicy({ writes: 'live', shell: 'live', compose: 'live' }), {
    reads: 'fixtures',
    writes: 'preview',
    model: 'stub',
    shell: 'simulate',
    compose: 'preview',
    allowedHttp: []
  });
  assert.equal(resolveLocalEffectPolicy({ writes: 'deny' }).writes, 'deny');
});

test('RunRecordV2 retains additive existing and extension fields', () => {
  const record: RunRecordV2 = {
    runId: 'run_1',
    status: 'succeeded',
    origin: 'local_dry_run',
    mode: 'preview',
    policy: resolveLocalEffectPolicy(),
    eventId: 'evt_1',
    eventContract: 'cron.tick@1',
    trace: [],
    actions: [],
    artifacts: { artifacts: [] },
    stateDiff: {},
    legacyCloudField: { retained: true }
  };
  assert.deepEqual(record.legacyCloudField, { retained: true });
});
