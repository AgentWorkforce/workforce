import assert from 'node:assert/strict';
import test from 'node:test';

import { createDelivery } from './delivery.js';
import {
  defaultRelaycastSender,
  resolveRelaycastUrl,
  DEFAULT_RELAYCAST_URL
} from './relaycast.js';
import type { WorkforceCtx } from '@agentworkforce/runtime';
import type { RelaycastSender } from './types.js';

function makeCtx(inputs: Record<string, string> = {}): WorkforceCtx {
  return { persona: { inputs, inputSpecs: {} }, log: () => {} } as unknown as WorkforceCtx;
}

type Captured = { url: string; init: RequestInit };

function stubFetch(response: () => Response): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response();
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function withRelayEnv(
  vars: Record<string, string | undefined>,
  fn: () => Promise<void>
): Promise<void> {
  const keys = ['WORKFORCE_AGENT_TOKEN', 'RELAY_AGENT_TOKEN', 'RELAY_API_KEY'];
  const saved: Record<string, string | undefined> = {};
  for (const key of keys) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) process.env[key] = value;
  }
  return fn().finally(() => {
    for (const key of keys) {
      saved[key] === undefined
        ? delete process.env[key]
        : (process.env[key] = saved[key]);
    }
  });
}

test('DEFAULT_RELAYCAST_URL is cast.agentrelay.com', () => {
  assert.equal(DEFAULT_RELAYCAST_URL, 'https://cast.agentrelay.com');
});

test('resolveRelaycastUrl: default, RELAY_BASE_URL, then RELAYCAST_URL precedence (trailing slash trimmed)', () => {
  const saved = { u: process.env.RELAYCAST_URL, b: process.env.RELAY_BASE_URL };
  try {
    delete process.env.RELAYCAST_URL;
    delete process.env.RELAY_BASE_URL;
    assert.equal(resolveRelaycastUrl(), 'https://cast.agentrelay.com');

    process.env.RELAY_BASE_URL = 'https://relay.example.com/';
    assert.equal(resolveRelaycastUrl(), 'https://relay.example.com');

    process.env.RELAYCAST_URL = 'https://cast.example.com';
    assert.equal(resolveRelaycastUrl(), 'https://cast.example.com'); // RELAYCAST_URL wins
  } finally {
    saved.u === undefined ? delete process.env.RELAYCAST_URL : (process.env.RELAYCAST_URL = saved.u);
    saved.b === undefined ? delete process.env.RELAY_BASE_URL : (process.env.RELAY_BASE_URL = saved.b);
  }
});

test('relaycast target DMs the inbound sender and returns a RelaycastRef', async () => {
  const sent: Array<{ to: string; text: string }> = [];
  const sender: RelaycastSender = {
    async dm(to, text) {
      sent.push({ to, text });
      return { ok: true, messageId: 'm1' };
    }
  };
  const delivery = createDelivery(makeCtx(), { relaycast: { to: 'local-tester', sender } });

  assert.deepEqual([...delivery.targets], ['relaycast']);
  const res = await delivery.send('hello over relay');
  assert.equal(res.ok, true);
  assert.deepEqual(sent, [{ to: 'local-tester', text: 'hello over relay' }]);
  assert.deepEqual(res.refs, [{ provider: 'relaycast', to: 'local-tester', messageId: 'm1' }]);
});

test('default sender prefers RELAY_AGENT_TOKEN over workflow and deprecated agent-token aliases', async () => {
  await withRelayEnv({
    RELAY_AGENT_TOKEN: 'tok_agent',
    WORKFORCE_AGENT_TOKEN: 'tok_workflow',
    RELAY_API_KEY: 'tok_legacy_agent'
  }, async () => {
    const { calls, restore } = stubFetch(() =>
      new Response(JSON.stringify({ ok: true, data: { message: { id: 'm2' } } }), { status: 200 })
    );
    try {
      const result = await defaultRelaycastSender(makeCtx()).dm('peer', 'hello');
      assert.deepEqual(result, { ok: true, messageId: 'm2' });
      assert.equal(calls.length, 1);
      assert.equal(
        (calls[0].init.headers as Record<string, string>).authorization,
        'Bearer tok_agent'
      );
    } finally {
      restore();
    }
  });
});

test('default sender never sends a workflow token to Relaycast', async () => {
  await withRelayEnv({ WORKFORCE_AGENT_TOKEN: 'tok_workflow' }, async () => {
    const { calls, restore } = stubFetch(() => new Response('{}', { status: 200 }));
    try {
      const result = await defaultRelaycastSender(makeCtx()).dm('peer', 'hello');
      assert.deepEqual(result, { ok: false });
      assert.equal(calls.length, 0);
    } finally {
      restore();
    }
  });
});

test('relaycast is NOT a target unless a reply address is supplied (event-driven, not config)', () => {
  assert.equal(createDelivery(makeCtx(), {}).targets.includes('relaycast'), false);
  // Even with slack configured, relaycast only appears when transports.relaycast.to is set.
  assert.deepEqual([...createDelivery(makeCtx({ SLACK_CHANNEL: 'C1' }), {}).targets], ['slack']);
});

test('onlyTargets can scope delivery to relaycast (origin-only reply)', () => {
  const sender: RelaycastSender = { async dm() { return { ok: true, messageId: 'x' }; } };
  const delivery = createDelivery(
    makeCtx({ SLACK_CHANNEL: 'C1' }),
    { relaycast: { to: 'peer', sender } },
    ['relaycast']
  );
  assert.deepEqual([...delivery.targets], ['relaycast']); // slack filtered out
});

test('relaycast-only send failure surfaces (matches slack/telegram all-targets-failed contract)', async () => {
  const sender: RelaycastSender = { async dm() { return { ok: false }; } };
  const delivery = createDelivery(makeCtx(), { relaycast: { to: 'peer', sender } });
  await assert.rejects(() => delivery.send('x'), /Delivery failed to all targets/);
});

test('relaycast ok:true with no messageId is treated as a failed delivery', async () => {
  const sender: RelaycastSender = { async dm() { return { ok: true }; } }; // no messageId
  const delivery = createDelivery(makeCtx(), { relaycast: { to: 'peer', sender } });
  await assert.rejects(() => delivery.send('x'), /Delivery failed to all targets/);
});

test('publish()/non-blocking does not invoke the relaycast sender', async () => {
  let calls = 0;
  const sender: RelaycastSender = { async dm() { calls++; return { ok: true, messageId: 'm' }; } };
  const delivery = createDelivery(makeCtx(), { relaycast: { to: 'peer', sender } });
  // relaycast is the only target → nothing delivered in non-blocking mode → throws,
  // and crucially the sender is never called (no draft-ref/threading path for relay).
  await assert.rejects(() => delivery.publish('x'), /Delivery failed to all targets/);
  assert.equal(calls, 0);
});
