/**
 * Format an HTTP response body for inclusion in a CLI error message.
 *
 * Common failure mode this guards against: the CLI hits the wrong URL
 * (missing `/cloud` basePath, marketing-site fallthrough, etc.) and the
 * server returns a full Next.js 404 page. Dumping the HTML verbatim
 * produces an unreadable wall of `<script>` tags. This helper detects
 * HTML and replaces it with a one-line hint that points at the cause.
 *
 * Non-HTML bodies are truncated to a reasonable length so a stray
 * stack trace doesn't drown the actual error message.
 */
export function formatHttpErrorBody(
  body: string | undefined | null,
  opts: { maxLength?: number; url?: string } = {}
): string {
  const trimmed = (body ?? '').trim();
  if (!trimmed) return '';
  if (looksLikeHtml(trimmed)) {
    const where = opts.url ? ` from ${opts.url}` : '';
    return `server returned HTML${where} — likely wrong API root (basePath missing, or fell through to a marketing/landing page). Body suppressed (${trimmed.length} bytes).`;
  }
  const max = opts.maxLength ?? 300;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max)}... (${trimmed.length - max} more bytes truncated)`;
}

function looksLikeHtml(body: string): boolean {
  const head = body.slice(0, 256).toLowerCase();
  if (head.startsWith('<!doctype html')) return true;
  if (head.startsWith('<html')) return true;
  if (/<head[\s>]/.test(head) && /<title[\s>]/.test(head)) return true;
  return false;
}
