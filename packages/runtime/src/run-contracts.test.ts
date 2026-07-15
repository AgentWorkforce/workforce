import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOCAL_EFFECT_POLICY_DEFAULTS,
  resolveLocalEffectPolicy,
  type PreviewAction,
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

test('RunRecordV2 JSON round-trip preserves richer transport preview fields', () => {
  interface TransportPreviewAction extends PreviewAction {
    method: 'write';
    path: string;
    parameters: Record<string, unknown>;
    body: Record<string, unknown>;
    simulatedReceipt: { id: string; timestamp: string };
  }

  const transportAction: TransportPreviewAction = {
    kind: 'provider.write',
    status: 'previewed',
    provider: 'slack',
    resource: 'messages',
    method: 'write',
    path: '/slack/channels/C123/messages/drafts/draft-1.json',
    parameters: { channel: 'C123' },
    body: { text: 'Preview only' },
    simulatedReceipt: { id: 'sim_1', timestamp: '2026-07-15T09:00:00.000Z' },
    data: {
      operation: 'write',
      simulatedReceipt: { id: 'sim_1', timestamp: '2026-07-15T09:00:00.000Z' }
    }
  };
  const record: RunRecordV2 = {
    runId: 'run_transport',
    status: 'succeeded',
    origin: 'local_dry_run',
    mode: 'preview',
    policy: resolveLocalEffectPolicy(),
    eventId: 'evt_transport',
    eventContract: 'slack.message.created@1',
    trace: [],
    actions: [transportAction],
    artifacts: { artifacts: [] },
    stateDiff: {}
  };

  const roundTripped = JSON.parse(JSON.stringify(record)) as RunRecordV2;
  const action = roundTripped.actions[0] as PreviewAction & Partial<TransportPreviewAction>;
  assert.equal(action.method, 'write');
  assert.equal(action.path, '/slack/channels/C123/messages/drafts/draft-1.json');
  assert.deepEqual(action.simulatedReceipt, {
    id: 'sim_1',
    timestamp: '2026-07-15T09:00:00.000Z'
  });
});
