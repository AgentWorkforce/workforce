import type { RelayContext, RelaySendResult, WorkforceCtx } from './types.js';

/**
 * Canonical relaycast gateway — SINGLE SOURCE OF TRUTH for the runtime relay
 * client. Override per-env via `RELAYCAST_URL` (preferred) or `RELAY_BASE_URL`
 * (the cloud launcher injects the latter, minted-against value into the box).
 * Mirrors `@agentworkforce/delivery`'s default; kept inline here because
 * delivery depends on runtime (importing it back would be circular).
 */
export const DEFAULT_RELAYCAST_URL = 'https://cast.agentrelay.com';

type Log = WorkforceCtx['log'];

function resolveRelaycastUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.RELAYCAST_URL?.trim() || env.RELAY_BASE_URL?.trim() || DEFAULT_RELAYCAST_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * Relaycast agent actions (`/v1/dm`, channel posts) are authenticated with the
 * Relaycast token, never the Relayfile/workflow `WORKFORCE_AGENT_TOKEN`.
 * `RELAY_API_KEY` is a deprecated compatibility alias and works here only
 * when it contains an agent-scoped token; workspace bootstrap keys cannot
 * authenticate these endpoints.
 */
function resolveAgentToken(env: NodeJS.ProcessEnv): string | undefined {
  return (
    env.RELAY_AGENT_TOKEN?.trim() ||
    env.RELAY_API_KEY?.trim() ||
    undefined
  );
}

const RELAY_TIMEOUT_MS = 8_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RELAY_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the relay context from the box environment. Always safe to call: when
 * no agent token is present every send returns `{ ok: false }` (logged).
 */
export function buildRelayContext(log: Log, env: NodeJS.ProcessEnv = process.env): RelayContext {
  const token = resolveAgentToken(env);
  const baseUrl = resolveRelaycastUrl(env);

  async function send(path: string, body: unknown, action: string): Promise<RelaySendResult> {
    if (!token) {
      log('warn', `relay.${action}.no-token`, {
        reason: 'no Relaycast token (RELAY_AGENT_TOKEN/RELAY_API_KEY) in the box'
      });
      return { ok: false };
    }
    const res = await fetchWithTimeout(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res) {
      log('warn', `relay.${action}.failed`, { reason: 'timeout or network error' });
      return { ok: false };
    }
    if (!res.ok) {
      log('warn', `relay.${action}.failed`, { status: res.status });
      return { ok: false };
    }
    // Relaycast REST wraps success as `{ ok, data }`; ids live under
    // data.message.id / data.id. Unwrap before reading.
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    const data =
      json && typeof json.data === 'object' && json.data !== null
        ? (json.data as Record<string, unknown>)
        : json;
    const message =
      data && typeof data.message === 'object' && data.message !== null
        ? (data.message as Record<string, unknown>)
        : undefined;
    const rawId = message?.id ?? data?.messageId ?? data?.id;
    return { ok: true, messageId: rawId != null ? String(rawId) : undefined };
  }

  return {
    dm: (to: string, text: string) => send('/v1/dm', { to, text }, 'dm'),
    post: (channel: string, text: string) =>
      send(`/v1/channels/${encodeURIComponent(channel)}/messages`, { text }, 'post')
  };
}
