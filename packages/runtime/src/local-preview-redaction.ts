import { redactEventValue } from '@agentworkforce/events';

const REDACTED = '[REDACTED]';
const SECRET_TEXT_PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[A-Za-z0-9._~+/=-]+\b/gi,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /xox[baprs]-[A-Za-z0-9-]+/g,
  /sk-(?:proj-)?[A-Za-z0-9_-]{16,}/g,
  /relay_(?:pa|ws)_[A-Za-z0-9._-]+/g,
  /x-access-token:[^@\s/'"]+/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9._-]+\.[A-Za-z0-9._-]+/g,
  /(OPENAI|ANTHROPIC|OPENCODE|OPENROUTER|GOOGLE|AWS|S3|DAYTONA|RELAY|SLACK|CLOUD|WORKFORCE|CODEX|CLAUDE)[A-Z0-9_]*(?:API)?_?(?:KEY|TOKEN|SECRET|CREDENTIALS?)\s*[:=]\s*["']?[^"'\s,}]+/gi,
  /"?(?:access_token|refresh_token|api_key|secret|password|private_key|client_secret|credential_json)"?\s*:\s*"(?:\\.|[^"\\])*"/gi,
];

const EXTRA_SENSITIVE_KEYS = [
  /access[_-]?token/i,
  /refresh[_-]?token/i,
  /client[_-]?secret/i,
  /credential_json/i,
  /session[_-]?token/i,
];

export function redactLocalPreviewValue<T>(value: T): T {
  return redactUnknown(redactEventValue(value, { additionalSensitiveKeys: EXTRA_SENSITIVE_KEYS })) as T;
}

export function redactLocalPreviewText(value: string): string {
  return SECRET_TEXT_PATTERNS.reduce((redacted, pattern) => redactPattern(redacted, pattern), value);
}

export function isCredentialLikeValue(value: string): boolean {
  return redactLocalPreviewText(value) !== value;
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === 'string') return redactLocalPreviewText(value);
  if (Array.isArray(value)) return value.map((entry) => redactUnknown(entry));
  if (!value || typeof value !== 'object') return value;

  const out: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    out[key] = redactUnknown(nested);
  }
  return out;
}

function redactPattern(value: string, pattern: RegExp): string {
  return value.replace(pattern, (match) => {
    const separator = match.includes(':') ? ':' : match.includes('=') ? '=' : '';
    if (!separator) return REDACTED;
    const [prefix] = match.split(separator);
    return `${prefix}${separator}${REDACTED}`;
  });
}
