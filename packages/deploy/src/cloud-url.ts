import { defaultApiUrl } from '@agent-relay/cloud';
import type { ActiveWorkspacePointer } from './login.js';

/**
 * Canonicalize the workforce cloud URL to the public host the user logged
 * into, regardless of which edge / origin-bypass URL the auth response
 * happened to come from.
 *
 * Why this exists: cloud's auth-result handler currently echoes
 * `request.url` back as `apiUrl`, so when the auth request happens to
 * route through the SST/Cloudflare origin-bypass (`origin.agentrelay.cloud`)
 * the CLI ends up persisting that hostname and sending every subsequent
 * API call to it. Session cookies and Bearer tokens don't validate
 * cross-subdomain, so every call 401s.
 *
 * This is a CLI-side mitigation; the proper structural fix is cloud-side
 * (the handler should emit a configured public URL, never `request.url`).
 *
 * Rules:
 *   - Map known-bypass hostnames back to their public cloud host:
 *     `origin.agentrelay.cloud` → `https://agentrelay.com/cloud` and
 *     `origin-<stage>.agentrelay.cloud` → `https://<stage>.agentrelay.cloud/cloud`.
 *   - Preserve stage-labeled public hosts such as `staging.agentrelay.cloud`
 *     so explicit staging deploys do not silently talk to production.
 *   - Add the `/cloud` base path for bare stage-labeled public hosts.
 *   - Map the apex `agentrelay.com` (no `/cloud` basePath) → canonical
 *     `https://agentrelay.com/cloud` so callers that hardcoded the apex
 *     don't land on the Next.js marketing 404 page.
 *   - Leave other hostnames untouched (dev `localhost:*`, custom tenants,
 *     etc.) — only the cloud-bypass family is remapped.
 *   - Strip a trailing slash so equality comparisons in the rest of the
 *     deploy code stay stable.
 */
export function canonicalizeCloudUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // If it doesn't parse as a URL we don't know how to remap it; return
    // the original (trimmed) string so the caller can choose to error
    // downstream.
    return trimmed;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'agentrelay.cloud' || host === 'origin.agentrelay.cloud') {
    return 'https://agentrelay.com/cloud';
  }
  if (host.startsWith('origin-') && host.endsWith('.agentrelay.cloud')) {
    return `https://${host.slice('origin-'.length)}/cloud`;
  }
  if (
    host.endsWith('.agentrelay.cloud') &&
    (url.pathname === '' || url.pathname === '/')
  ) {
    return `https://${host}/cloud`;
  }
  if (
    host === 'agentrelay.com'
    && (url.pathname === '' || url.pathname === '/')
  ) {
    // Apex without the /cloud basePath would route to the marketing site
    // and 404 every API call. Public docs/login flows always include the
    // /cloud prefix — treat the bare apex as a user mistake and fix it
    // before it produces a wall of HTML in error messages.
    return 'https://agentrelay.com/cloud';
  }
  return stripTrailingSlash(url.toString());
}

/**
 * Single source of truth for "which cloud URL should this CLI invocation
 * talk to?" Resolution order, top wins:
 *
 *   1. Explicit `--cloud-url` flag.
 *   2. `WORKFORCE_DEPLOY_CLOUD_URL` (preferred env override).
 *   3. `WORKFORCE_CLOUD_URL` (legacy env override).
 *   4. Deprecated compatibility active pointer supplied by a caller.
 *   5. `defaultApiUrl()` from `@agent-relay/cloud` (the public canonical
 *      URL — currently `https://agentrelay.com/cloud`).
 *
 * The result is always run through {@link canonicalizeCloudUrl} so
 * downstream consumers never see an origin-bypass hostname or the
 * `/cloud`-less apex.
 */
export function resolveCloudUrl(context: CloudUrlContext = {}): string {
  const env = context.env ?? process.env;
  const raw = firstTruthy(
    context.flag,
    env.WORKFORCE_DEPLOY_CLOUD_URL,
    env.WORKFORCE_CLOUD_URL,
    context.active?.cloudUrl,
    defaultApiUrl()
  );
  return canonicalizeCloudUrl(raw);
}

export interface CloudUrlContext {
  /** Explicit `--cloud-url` flag value, if any. */
  flag?: string | undefined;
  /** Process env override; defaults to `process.env`. Pass `{}` to ignore env. */
  env?: NodeJS.ProcessEnv;
  /** Deprecated compatibility pointer. New callers should not pass this. */
  active?: Pick<ActiveWorkspacePointer, 'cloudUrl'> | null | undefined;
}

function firstTruthy(...candidates: Array<string | undefined>): string {
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
