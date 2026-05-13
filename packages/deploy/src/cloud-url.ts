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
 *   - Map known-bypass hostnames (`origin.agentrelay.cloud`,
 *     `*.agentrelay.cloud`) → canonical `https://agentrelay.com/cloud`.
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
  if (host === 'agentrelay.cloud' || host.endsWith('.agentrelay.cloud')) {
    return 'https://agentrelay.com/cloud';
  }
  return stripTrailingSlash(url.toString());
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '');
}
