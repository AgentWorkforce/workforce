import test from 'node:test';
import assert from 'node:assert/strict';

import { buildRelayContext, DEFAULT_RELAYCAST_URL } from './relay.js';

const noopLog = () => {};

type Captured = { url: string; init: RequestInit };

/** Install a capturing fetch stub; returns the captured calls + a restore fn. */
function stubFetch(response: () => Response): { calls: Captured[]; restore: () => void } {
  const calls: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    return response();
  }) as typeof fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}

function withEnv(vars: Record<string, string | undefined>, fn: () => Promise<void>): Promise<void> {
  const keys = ['RELAYCAST_URL', 'RELAY_BASE_URL', 'WORKFORCE_AGENT_TOKEN', 'RELAY_AGENT_TOKEN', 'RELAY_API_KEY'];
  const saved: Record<string, string | undefined> = {};
  for (const k of keys) { saved[k] = process.env[k]; delete process.env[k]; }
  for (const [k, v] of Object.entries(vars)) { if (v !== undefined) process.env[k] = v; }
  return fn().finally(() => {
    for (const k of keys) { saved[k] === undefined ? delete process.env[k] : (process.env[k] = saved[k]); }
  });
}

test('dm posts /v1/dm with bearer agent token + {to,text}, unwraps {ok,data} id', async () => {
  await withEnv({ RELAY_AGENT_TOKEN: 'tok_agent' }, async () => {
    const { calls, restore } = stubFetch(() =>
      new Response(JSON.stringify({ ok: true, data: { message: { id: 'm1' } } }), { status: 200 })
    );
    try {
      const relay = buildRelayContext(noopLog);
      const res = await relay.dm('peer-agent', 'hello over relay');
      assert.deepEqual(res, { ok: true, messageId: 'm1' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, `${DEFAULT_RELAYCAST_URL}/v1/dm`);
      assert.equal(calls[0].init.method, 'POST');
      assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer tok_agent');
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), { to: 'peer-agent', text: 'hello over relay' });
    } finally {
      restore();
    }
  });
});

test('agent token precedence: WORKFORCE_AGENT_TOKEN over RELAY_API_KEY', async () => {
  await withEnv({ WORKFORCE_AGENT_TOKEN: 'tok_wf', RELAY_API_KEY: 'rk_live_x' }, async () => {
    const { calls, restore } = stubFetch(() => new Response(JSON.stringify({ ok: true, data: { id: 'm2' } }), { status: 200 }));
    try {
      await buildRelayContext(noopLog).dm('p', 'hi');
      assert.equal((calls[0].init.headers as Record<string, string>).authorization, 'Bearer tok_wf');
    } finally {
      restore();
    }
  });
});

test('RELAYCAST_URL overrides the default gateway (trailing slash trimmed)', async () => {
  await withEnv({ RELAY_API_KEY: 'rk', RELAYCAST_URL: 'https://cast.example.com/' }, async () => {
    const { calls, restore } = stubFetch(() => new Response(JSON.stringify({ ok: true, data: { id: 'm' } }), { status: 200 }));
    try {
      await buildRelayContext(noopLog).post('general', 'yo');
      assert.equal(calls[0].url, 'https://cast.example.com/v1/channels/general/messages');
      assert.deepEqual(JSON.parse(String(calls[0].init.body)), { text: 'yo' });
    } finally {
      restore();
    }
  });
});

test('no agent token → {ok:false} and no fetch', async () => {
  await withEnv({}, async () => {
    const { calls, restore } = stubFetch(() => new Response('{}', { status: 200 }));
    try {
      const res = await buildRelayContext(noopLog).dm('p', 'hi');
      assert.deepEqual(res, { ok: false });
      assert.equal(calls.length, 0);
    } finally {
      restore();
    }
  });
});

test('non-2xx response → {ok:false}', async () => {
  await withEnv({ RELAY_AGENT_TOKEN: 'tok' }, async () => {
    const { restore } = stubFetch(() => new Response('nope', { status: 401 }));
    try {
      assert.deepEqual(await buildRelayContext(noopLog).dm('p', 'hi'), { ok: false });
    } finally {
      restore();
    }
  });
});
