import type { WorkforceCtx } from '@agentworkforce/runtime';
import type { RelaycastSender } from './types.js';

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
 * Default relaycast sender — DMs a peer agent via `POST /v1/dm` using the box's
 * injected `RELAY_API_KEY`. Never throws: returns `{ ok: false }` (logged) when
 * the key is missing or the call fails, so a relay reply degrades gracefully
 * rather than crashing the handler.
 */
export function defaultRelaycastSender(ctx: WorkforceCtx): RelaycastSender {
  const apiKey = process.env.RELAY_API_KEY?.trim();
  const baseUrl = resolveRelaycastUrl();
  return {
    async dm(to: string, text: string): Promise<{ ok: boolean; messageId?: string }> {
      if (!apiKey) {
        ctx.log?.('warn', 'delivery.relaycast.no-api-key', {
          reason: 'RELAY_API_KEY not present in the agent box'
        });
        return { ok: false };
      }
      try {
        const res = await fetch(`${baseUrl}/v1/dm`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({ to, text })
        });
        if (!res.ok) {
          ctx.log?.('warn', 'delivery.relaycast.send-failed', { to, status: res.status });
          return { ok: false };
        }
        const data = (await res.json().catch(() => null)) as
          | { message?: { id?: unknown }; messageId?: unknown; id?: unknown }
          | null;
        const rawId = data?.message?.id ?? data?.messageId ?? data?.id;
        return { ok: true, messageId: rawId != null ? String(rawId) : undefined };
      } catch (err) {
        ctx.log?.('warn', 'delivery.relaycast.send-error', { to, error: String(err) });
        return { ok: false };
      }
    }
  };
}
