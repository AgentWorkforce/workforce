import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FleetActionContext } from '@agent-relay/fleet';
import type { DeployResult, ModeLaunchHandle } from '@agentworkforce/deploy';
import {
  __setDeployForTest,
  buildEnvelopeFromTriggerMessage,
  defineWorkforcePersonaNode,
  type RunEventInput,
  type TriggerMessage
} from './index.js';

function baseMessage(overrides: Partial<TriggerMessage> = {}): TriggerMessage {
  return {
    id: 'msg_1',
    channel_id: 'ch_1',
    channel_name: 'local-surface-demo',
    agent_id: 'agent_webhook',
    text: 'issues.opened',
    created_at: '2026-07-15T00:00:00.000Z',
    metadata: {
      __relaycast_origin: 'inbound_webhook',
      __relaycast_webhook_id: 'wh_1',
      provider: 'github',
      connectionId: 'conn_1',
      workspaceId: 'ws_1',
      eventType: 'issues.opened',
      objectType: 'issue',
      objectId: '42',
      payload: { action: 'opened', issue: { number: 42 } },
      path: '/github/repos/acme/app/issues/42',
      deliveryId: 'dlv_abc',
      timestamp: '2026-07-15T00:00:01.000Z'
    },
    ...overrides
  };
}

test('buildEnvelopeFromTriggerMessage maps a webhook-delivered message to a RawGatewayEnvelope', () => {
  const envelope = buildEnvelopeFromTriggerMessage(baseMessage(), 'fallback-ws');
  assert.ok(envelope);
  assert.equal(envelope?.id, 'dlv_abc');
  assert.equal(envelope?.workspace, 'ws_1');
  assert.equal(envelope?.type, 'github.issues.opened');
  assert.equal(envelope?.provider, 'github');
  assert.equal(envelope?.eventType, 'issues.opened');
  assert.equal(envelope?.deliveryId, 'dlv_abc');
  assert.equal(envelope?.occurredAt, '2026-07-15T00:00:01.000Z');
  assert.deepEqual(envelope?.paths, ['/github/repos/acme/app/issues/42']);
  assert.deepEqual(envelope?.resource, { action: 'opened', issue: { number: 42 } });
});

test('buildEnvelopeFromTriggerMessage falls back to message.id and created_at when the payload omits them', () => {
  const message = baseMessage({
    metadata: {
      provider: 'linear',
      eventType: 'issue.created',
      payload: { id: 'lin_1' }
    }
  });
  const envelope = buildEnvelopeFromTriggerMessage(message, 'fallback-ws');
  assert.ok(envelope);
  // Mirrors cloud's real `buildPayload` fallback exactly
  // (`${provider}:${eventType}:${Date.now().toString(36)}`), not the
  // relaycast message id — cloud's gateway never falls back to that.
  assert.match(envelope!.id, /^linear:issue\.created:[0-9a-z]+$/);
  assert.equal(envelope?.workspace, 'fallback-ws');
  assert.equal(envelope?.occurredAt, '2026-07-15T00:00:00.000Z');
  assert.equal(envelope?.deliveryId, undefined);
  assert.equal(envelope?.paths, undefined);
});

test('buildEnvelopeFromTriggerMessage preserves a non-plain-object payload verbatim (no silent coercion to {})', () => {
  const message = baseMessage({
    metadata: {
      provider: 'github',
      eventType: 'check_run.requested_action',
      deliveryId: 'dlv_array',
      payload: [{ action: 'requested' }, { action: 'created' }]
    }
  });
  const envelope = buildEnvelopeFromTriggerMessage(message, 'fallback-ws');
  assert.ok(envelope);
  assert.deepEqual(envelope?.resource, [{ action: 'requested' }, { action: 'created' }]);
});

test('buildEnvelopeFromTriggerMessage returns null for messages without provider/eventType (e.g. a human chat message)', () => {
  const message = baseMessage({ metadata: { __relaycast_origin: 'chat' } });
  assert.equal(buildEnvelopeFromTriggerMessage(message, 'fallback-ws'), null);

  const noMetadata = baseMessage({ metadata: null });
  assert.equal(buildEnvelopeFromTriggerMessage(noMetadata, 'fallback-ws'), null);
});

function fakeCtx(nodeName: string): FleetActionContext {
  return {
    node: { name: nodeName, capabilities: ['run-event'] },
    relay: { sendMessage: async () => undefined },
    spawnAgent: async () => undefined
  };
}

function fakeRunHandle(writes: string[]): ModeLaunchHandle {
  return {
    id: 'pid:1234',
    stop: async () => undefined,
    done: Promise.resolve({ code: 0 }),
    write: (line: string) => {
      writes.push(line);
    }
  };
}

test('defineWorkforcePersonaNode registers a run-event action with an onMessage({channel}) trigger', () => {
  const definition = defineWorkforcePersonaNode({
    personaPath: '/personas/demo.json',
    channel: 'local-surface-demo',
    connection: { workspace: 'ws_1', workspaceToken: 'tok_1' }
  });
  assert.ok(definition.capabilities['run-event']);
  assert.equal(definition.triggers.length, 1);
  assert.equal(definition.triggers[0]?.type, 'message');
  assert.equal(definition.triggers[0]?.channel, 'local-surface-demo');
  assert.equal(definition.triggers[0]?.actionName, 'run-event');
});

test('run-event handler lazily launches the persona once and writes each event to the child stdin', async () => {
  const writes: string[] = [];
  const runHandle = fakeRunHandle(writes);
  let deployCalls = 0;
  let capturedToken: string | undefined;
  __setDeployForTest(async (opts, resolvers) => {
    deployCalls += 1;
    assert.equal(opts.mode, 'dev');
    assert.equal(opts.detach, true);
    assert.equal(opts.workspace, 'ws_1');
    const resolved = await resolvers?.workspaceAuth?.resolveWorkspace({ io: undefined as never });
    capturedToken = resolved?.token;
    return { runHandle } as unknown as DeployResult;
  });

  try {
    const definition = defineWorkforcePersonaNode({
      personaPath: '/personas/demo.json',
      channel: 'local-surface-demo',
      connection: { workspace: 'ws_1', workspaceToken: 'tok_1' }
    });
    const handler = definition.capabilities['run-event']!.handler;
    const ctx = fakeCtx(definition.name);

    const input: RunEventInput = { trigger_id: 'trg_1', message: baseMessage() };
    await handler(input, ctx);
    await handler(input, ctx);

    assert.equal(deployCalls, 1, 'deploy() launches the persona once, not per message');
    assert.equal(capturedToken, 'tok_1');
    assert.equal(writes.length, 2);
    const parsed = JSON.parse(writes[0]!.trimEnd());
    assert.equal(parsed.type, 'github.issues.opened');
    assert.ok(writes[0]!.endsWith('\n'));
  } finally {
    __setDeployForTest(undefined);
  }
});

test('run-event handler skips launching the persona when the message is not a webhook delivery', async () => {
  let deployCalls = 0;
  __setDeployForTest(async () => {
    deployCalls += 1;
    throw new Error('should not be called');
  });

  try {
    const definition = defineWorkforcePersonaNode({
      personaPath: '/personas/demo.json',
      channel: 'local-surface-demo',
      connection: { workspace: 'ws_1', workspaceToken: 'tok_1' }
    });
    const handler = definition.capabilities['run-event']!.handler;
    const ctx = fakeCtx(definition.name);
    const result = await handler(
      { trigger_id: 'trg_1', message: baseMessage({ metadata: { __relaycast_origin: 'chat' } }) },
      ctx
    );
    assert.deepEqual(result, { ok: true, skipped: 'unsupported message shape' });
    assert.equal(deployCalls, 0);
  } finally {
    __setDeployForTest(undefined);
  }
});

test('run-event handler rejects when connection.workspaceToken is missing', async () => {
  __setDeployForTest(async (_opts, resolvers) => {
    // deploy() itself calls resolveWorkspace(); reproduce that here.
    await resolvers?.workspaceAuth?.resolveWorkspace({ io: undefined as never });
    throw new Error('unreachable: resolveWorkspace should have thrown first');
  });

  try {
    const definition = defineWorkforcePersonaNode({
      personaPath: '/personas/demo.json',
      channel: 'local-surface-demo',
      connection: { workspace: 'ws_1' }
    });
    const handler = definition.capabilities['run-event']!.handler;
    const ctx = fakeCtx(definition.name);
    await assert.rejects(
      async () => handler({ trigger_id: 'trg_1', message: baseMessage() }, ctx),
      /workspaceToken is required/
    );
  } finally {
    __setDeployForTest(undefined);
  }
});
