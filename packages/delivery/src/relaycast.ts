import type { WorkforceCtx } from '@agentworkforce/runtime';
import type { RelaycastSender } from './types.js';
import { fetchWithTimeout } from './helpers.js';

/**
 * Canonical relaycast gateway — SINGLE SOURCE OF TRUTH. Change this one
 * constant to move the default gateway. Per-env override via `RELAYCAST_URL`
 * (preferred) or `RELAY_BASE_URL`.
 */
export const DEFAULT_RELAYCAST_URL = 'https://cast.agentrelay.com';

/** Resolve the relaycast base URL: RELAYCAST_URL > RELAY_BASE_URL > default. */
export function resolveRelaycastUrl(): string {
  const raw =
    process.env.RELAYCAST_URL?.trim() ||
    process.env.RELAY_BASE_URL?.trim() ||
    DEFAULT_RELAYCAST_URL;
  return raw.replace(/\/+$/, '');
}

/**
 * Resolve the token to authenticate relaycast agent actions (DMs). `/v1/dm` is
 * secured with an agent credential, not the Relayfile/workflow token. Prefer
 * `RELAY_AGENT_TOKEN`. `RELAY_API_KEY` is a deprecated compatibility alias and
 * works here only when it contains an agent-scoped token; workspace bootstrap
 * keys cannot authenticate this endpoint. Mirrors the runtime's resolution.
 */
function resolveRelayAgentToken(): string | undefined {
  return (
    process.env.RELAY_AGENT_TOKEN?.trim() ||
    process.env.RELAY_API_KEY?.trim() ||
    undefined
  );
}

/**
 * Default relaycast sender — DMs a peer agent via `POST /v1/dm` using the box's
 * injected agent token. Bounded by `fetchWithTimeout` and never throws: returns
 * `{ ok: false }` (logged) on missing token, timeout, or non-2xx, so a relay
 * reply degrades gracefully rather than crashing the handler.
 */
export function defaultRelaycastSender(ctx: WorkforceCtx): RelaycastSender {
  const token = resolveRelayAgentToken();
  const baseUrl = resolveRelaycastUrl();
  return {
    async dm(to: string, text: string): Promise<{ ok: boolean; messageId?: string }> {
      if (!token) {
        ctx.log?.('warn', 'delivery.relaycast.no-token', {
          reason: 'no Relaycast token (RELAY_AGENT_TOKEN/RELAY_API_KEY) in the agent box'
        });
        return { ok: false };
      }
      const res = await fetchWithTimeout(`${baseUrl}/v1/dm`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ to, text })
      });
      if (!res) {
        ctx.log?.('warn', 'delivery.relaycast.send-failed', { to, reason: 'timeout or network error' });
        return { ok: false };
      }
      if (!res.ok) {
        ctx.log?.('warn', 'delivery.relaycast.send-failed', { to, status: res.status });
        return { ok: false };
      }
      // Relaycast REST wraps success as `{ ok, data }`; the /dm message id lives
      // under `data.message.id` (or legacy `data.id`). Unwrap before reading.
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
  };
}
