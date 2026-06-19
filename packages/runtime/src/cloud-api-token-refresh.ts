// Keeps the proactive sandbox's cloud API bearer fresh.
//
// The sandbox's `CLOUD_API_ACCESS_TOKEN` is a relayfile-audience JWT minted
// once at launch with a short TTL (≈2h) and no in-sandbox refresh. A
// long-running proactive agent that posts to Slack after the TTL lapses sends
// an expired-but-validly-signed bearer, the cloud verifier returns null, and
// the request 401s wholesale (cloud#2307).
//
// relayauth's refresh contract is single-use rotating: presenting an already
// rotated refresh token cascade-revokes the whole session. So refresh here is
// SERIALIZED (single in-flight) and ROTATES-AND-PERSISTS every CLOUD_API_* env
// var in place. We persist both `CLOUD_API_ACCESS_TOKEN` (read by
// `ctx.cloudApi.token`) and `CLOUD_API_TOKEN` (the relayflows Slack adapter's
// env fallback, adapter.ts:31) so neither consumer path goes stale.
//
// Because the access token is re-minted via the derived `/v1/tokens/agent`
// pair endpoint, the refreshed token keeps `aud:["relayfile"]` (the audience
// is persisted in token meta and replayed on rotation) — a plain `/v1/tokens`
// mint would silently downgrade the audience on refresh.

/** Refresh once the access token is within this window of expiry (or past it). */
const DEFAULT_REFRESH_SKEW_MS = 5 * 60 * 1000;

/** Env vars rotated together. `CLOUD_API_REFRESH_URL` points at relayauth's
 * `/v1/tokens/refresh`, NOT the cloud API. */
export interface CloudApiTokenEnv {
  CLOUD_API_ACCESS_TOKEN?: string;
  CLOUD_API_TOKEN?: string;
  CLOUD_API_REFRESH_TOKEN?: string;
  CLOUD_API_ACCESS_TOKEN_EXPIRES_AT?: string;
  CLOUD_API_REFRESH_URL?: string;
}

interface RefreshTokenResponse {
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  refreshTokenExpiresAt?: string;
}

/** Thrown when relayauth rejects the refresh token (401) — the delegation
 * horizon has elapsed or the session was revoked. The caller must re-mint
 * (e.g. recycle the sandbox); retrying the refresh will not recover. */
export class CloudApiTokenHorizonError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CloudApiTokenHorizonError';
  }
}

export interface EnsureFreshOptions {
  /** Override the clock (tests). */
  now?: number;
  /** Override the pre-expiry refresh window. */
  skewMs?: number;
  /** Override fetch (tests). */
  fetchImpl?: typeof fetch;
}

// Single in-flight refresh shared across concurrent callers in this process.
// The sandbox holds one cloud API identity, so a process-wide guard is correct:
// concurrent posters await the SAME rotation rather than each spending the
// single-use refresh token (which would cascade-revoke the session).
let inFlightRefresh: Promise<string> | null = null;

function trimmed(value: string | undefined): string {
  return value?.trim() ?? '';
}

/**
 * Returns a non-expired cloud API access token, refreshing in place if the
 * current one is within `skewMs` of expiry. Persists the rotated token pair
 * back onto `env` so subsequently-read consumers (`ctx.cloudApi`, the
 * relayflows env fallback) see the fresh value.
 *
 * Returns the current token unchanged when it is still fresh, or when no
 * refresh material is present (the caller then handles any 401 itself).
 * Throws {@link CloudApiTokenHorizonError} when refresh is rejected at the
 * delegation horizon.
 */
export async function ensureFreshCloudApiToken(
  env: CloudApiTokenEnv = process.env as CloudApiTokenEnv,
  opts: EnsureFreshOptions = {}
): Promise<string> {
  const now = opts.now ?? Date.now();
  const skewMs = opts.skewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const accessToken = trimmed(env.CLOUD_API_ACCESS_TOKEN);
  const expiresAt = trimmed(env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT);

  // Still comfortably valid → leave everything untouched.
  if (accessToken && expiresAt) {
    const expiresMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresMs) && expiresMs - now > skewMs) {
      return accessToken;
    }
  }

  const refreshToken = trimmed(env.CLOUD_API_REFRESH_TOKEN);
  const refreshUrl = trimmed(env.CLOUD_API_REFRESH_URL);
  if (!refreshToken || !refreshUrl) {
    // No way to refresh in-sandbox; hand back whatever we have.
    return accessToken;
  }

  if (!inFlightRefresh) {
    const fetchImpl = opts.fetchImpl ?? fetch;
    inFlightRefresh = refreshAndPersist(env, refreshUrl, refreshToken, fetchImpl).finally(() => {
      inFlightRefresh = null;
    });
  }
  return inFlightRefresh;
}

async function refreshAndPersist(
  env: CloudApiTokenEnv,
  refreshUrl: string,
  refreshToken: string,
  fetchImpl: typeof fetch
): Promise<string> {
  const response = await fetchImpl(refreshUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ refreshToken })
  });

  if (response.status === 401) {
    const body = await response.text().catch(() => '');
    throw new CloudApiTokenHorizonError(
      `cloud API token refresh rejected (401) — delegation horizon elapsed or session revoked; re-mint required${body ? `: ${body}` : ''}`
    );
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`cloud API token refresh failed: ${response.status}${body ? ` ${body}` : ''}`);
  }

  const pair = (await response.json()) as RefreshTokenResponse;
  const nextAccess = trimmed(pair.accessToken);
  const nextRefresh = trimmed(pair.refreshToken);
  if (!nextAccess || !nextRefresh) {
    throw new Error('cloud API token refresh response missing accessToken/refreshToken');
  }

  // Rotate-and-persist. Both token vars carry the same value so the
  // `ctx.cloudApi.token` reader and the relayflows env fallback stay in sync.
  env.CLOUD_API_ACCESS_TOKEN = nextAccess;
  env.CLOUD_API_TOKEN = nextAccess;
  env.CLOUD_API_REFRESH_TOKEN = nextRefresh;
  env.CLOUD_API_ACCESS_TOKEN_EXPIRES_AT = trimmed(pair.accessTokenExpiresAt);

  return nextAccess;
}

/** Default background tick. Must be well under the refresh skew so no Slack
 * post lands in a gap where the token has expired but no tick has fired. */
const DEFAULT_REFRESHER_INTERVAL_MS = 60 * 1000;

export interface RefresherHandle {
  stop(): void;
}

export interface StartRefresherOptions extends EnsureFreshOptions {
  /** Env bag to keep fresh. Defaults to `process.env`. */
  env?: CloudApiTokenEnv;
  /** Tick interval; default 60s (< the 5-min skew). */
  intervalMs?: number;
  /** Transient refresh failure (network/5xx). The loop keeps ticking. */
  onError?(err: unknown): void;
  /** Delegation horizon elapsed (refresh 401). The loop STOPS — only a
   * re-mint (new sandbox token) can recover, which is out of band. */
  onHorizonElapsed?(err: CloudApiTokenHorizonError): void;
}

/**
 * Starts a background loop that keeps the cloud API token fresh in `env`.
 *
 * Each tick is a no-op until the access token is within the refresh skew of
 * expiry, then it rotates-and-persists in place. Because relayflows rebuilds
 * its Slack adapter per step and reads `env.CLOUD_API_TOKEN` at that point
 * (adapter.ts:31), keeping `process.env` fresh in the same process means every
 * per-step client picks up a live token — no per-call hook needed.
 *
 * NOTE: only effective when the relayflows SDK runs in THIS process (shared
 * `process.env`). If the SDK runs in a subprocess, the refresher must run there
 * instead.
 *
 * Ticks are scheduled with `setTimeout` (not `setInterval`) so a slow refresh
 * never overlaps the next tick, and the timer is `unref`'d so it never keeps
 * the process alive.
 */
export function startCloudApiTokenRefresher(opts: StartRefresherOptions = {}): RefresherHandle {
  const env = opts.env ?? (process.env as CloudApiTokenEnv);
  const intervalMs = opts.intervalMs ?? DEFAULT_REFRESHER_INTERVAL_MS;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function stop(): void {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function schedule(): void {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick();
    }, intervalMs);
    (timer as unknown as { unref?: () => void }).unref?.();
  }

  async function tick(): Promise<void> {
    if (stopped) return;
    try {
      await ensureFreshCloudApiToken(env, opts);
    } catch (err) {
      if (err instanceof CloudApiTokenHorizonError) {
        opts.onHorizonElapsed?.(err);
        stop();
        return;
      }
      opts.onError?.(err);
    }
    schedule();
  }

  schedule();
  return { stop };
}

/** Test hook: reset the process-wide in-flight guard between cases. */
export function resetInFlightRefreshForTests(): void {
  inFlightRefresh = null;
}
