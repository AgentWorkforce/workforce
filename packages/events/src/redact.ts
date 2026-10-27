const REDACTED = '[REDACTED]';
const SENSITIVE_KEY = /(?:authorization|cookie|password|passwd|secret|token|api[-_]?key|private[-_]?key)/i;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi;

export interface RedactOptions {
  additionalSensitiveKeys?: readonly (string | RegExp)[];
}

/** Clone and redact a JSON-like value without mutating the provider payload. */
export function redactEventValue<T>(value: T, options: RedactOptions = {}): T {
  return visit(value, options, new WeakMap<object, unknown>()) as T;
}

function visit(value: unknown, options: RedactOptions, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === 'string') return value.replace(BEARER, REDACTED);
  if (value === null || typeof value !== 'object') return value;
  const cached = seen.get(value);
  if (cached !== undefined) return cached;
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(visit(item, options, seen));
    return out;
  }
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [key, child] of Object.entries(value)) {
    Object.defineProperty(out, key, {
      value: isSensitiveKey(key, options.additionalSensitiveKeys) ? REDACTED : visit(child, options, seen),
      enumerable: true,
      configurable: true,
      writable: true
    });
  }
  return out;
}

function isSensitiveKey(key: string, additional: RedactOptions['additionalSensitiveKeys']): boolean {
  if (SENSITIVE_KEY.test(key)) return true;
  return additional?.some((matcher) => {
    if (typeof matcher === 'string') return matcher.toLowerCase() === key.toLowerCase();
    matcher.lastIndex = 0;
    const matches = matcher.test(key);
    matcher.lastIndex = 0;
    return matches;
  }) ?? false;
}

function isPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
