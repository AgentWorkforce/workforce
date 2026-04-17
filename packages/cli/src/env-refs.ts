/**
 * Resolve env references in persona `env` / `mcpServers` values against the
 * caller's process environment. Two reference forms are supported:
 *
 *   "$VAR"            whole-string reference; replaced by the env var value.
 *   "Bearer ${VAR}"   braced reference(s), interpolated anywhere in the
 *                     string. Useful for header prefixes like `Bearer …`.
 *
 * Bare `$VAR` that appears *inside* a longer string (without braces) is kept
 * as a literal — we only interpolate when the intent is unambiguous, so a
 * literal `$` in a JSON string doesn't accidentally get eaten.
 *
 * A missing env var is a hard error naming both the referenced variable and
 * the persona field that asked for it.
 */

export type EnvRefResolver = (value: string) => string;

const WHOLE_REF = /^\$([A-Z_][A-Z0-9_]*)$/;
const BRACED_REF = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

export class MissingEnvRefError extends Error {
  readonly ref: string;
  readonly referencedBy: string;
  constructor(ref: string, referencedBy: string) {
    super(
      `Environment variable ${ref} is required by persona field \`${referencedBy}\` but is not set in the current shell. Export it and retry.`
    );
    this.name = 'MissingEnvRefError';
    this.ref = ref;
    this.referencedBy = referencedBy;
  }
}

export function makeEnvRefResolver(processEnv: NodeJS.ProcessEnv): (
  value: string,
  field: string
) => string {
  return (value, field) => {
    const whole = WHOLE_REF.exec(value);
    if (whole) {
      const name = whole[1];
      const resolved = processEnv[name];
      if (resolved === undefined || resolved === '') {
        throw new MissingEnvRefError(name, field);
      }
      return resolved;
    }

    if (!value.includes('${')) return value;

    return value.replace(BRACED_REF, (_, name: string) => {
      const resolved = processEnv[name];
      if (resolved === undefined || resolved === '') {
        throw new MissingEnvRefError(name, field);
      }
      return resolved;
    });
  };
}

export function resolveStringMap(
  map: Record<string, string> | undefined,
  processEnv: NodeJS.ProcessEnv,
  fieldPrefix: string
): Record<string, string> | undefined {
  if (!map) return undefined;
  const resolve = makeEnvRefResolver(processEnv);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(map)) {
    out[key] = resolve(value, `${fieldPrefix}.${key}`);
  }
  return out;
}

/**
 * Like {@link makeEnvRefResolver} but never throws on missing refs. Returns
 * a result object the caller can inspect to decide whether a missing ref is
 * fatal (e.g. a `url` / `command`) or droppable (e.g. a specific header).
 */
export type LenientResult =
  | { ok: true; value: string }
  | { ok: false; field: string; ref: string };

export function makeLenientResolver(
  processEnv: NodeJS.ProcessEnv
): (value: string, field: string) => LenientResult {
  const strict = makeEnvRefResolver(processEnv);
  return (value, field) => {
    try {
      return { ok: true, value: strict(value, field) };
    } catch (err) {
      if (err instanceof MissingEnvRefError) {
        return { ok: false, field, ref: err.ref };
      }
      throw err;
    }
  };
}

export interface DroppedRef {
  field: string;
  ref: string;
}

/**
 * Walk a `Record<string,string>`, resolving each value leniently. Entries
 * whose value referenced an unset env var are dropped from the result and
 * reported via `dropped`. Literal strings and successfully-resolved refs
 * pass through to `value`.
 *
 * Returns `value: undefined` when every entry was either dropped or the map
 * itself was undefined — callers can use that to decide whether to emit a
 * flag at all.
 */
export function resolveStringMapLenient(
  map: Record<string, string> | undefined,
  processEnv: NodeJS.ProcessEnv,
  fieldPrefix: string
): { value: Record<string, string> | undefined; dropped: DroppedRef[] } {
  if (!map) return { value: undefined, dropped: [] };
  const resolve = makeLenientResolver(processEnv);
  const out: Record<string, string> = {};
  const dropped: DroppedRef[] = [];
  for (const [key, raw] of Object.entries(map)) {
    const field = `${fieldPrefix}.${key}`;
    const result = resolve(raw, field);
    if (result.ok) {
      out[key] = result.value;
    } else {
      dropped.push({ field: result.field, ref: result.ref });
    }
  }
  return {
    value: Object.keys(out).length > 0 ? out : undefined,
    dropped
  };
}
