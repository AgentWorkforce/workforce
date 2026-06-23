import type { WorkforceCtx } from '@agentworkforce/runtime';

/**
 * Resolve a persona input value from the runtime ctx.
 *
 * Resolution order (mirrors persona-kit): agent-provided value →
 * process env (`spec.env` or the input key) → spec default.
 */
export function input(ctx: WorkforceCtx, name: string): string | undefined {
  const spec = ctx.persona.inputSpecs?.[name];
  const v = process.env[spec?.env ?? name] ?? ctx.persona.inputs?.[name] ?? spec?.default;
  return v && String(v).trim() ? String(v).trim() : undefined;
}

/**
 * Split a comma-separated string into trimmed, non-empty entries.
 */
export function list(raw: string | undefined): string[] {
  return (raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

/**
 * Race a promise against a timeout. On timeout the timer rejects with an
 * Error so the caller can catch and fall back. Always clears the timer.
 */
export async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/**
 * Fetch with an AbortController timeout. Returns the response on success,
 * or undefined on timeout/network error (never throws).
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = 8_000
): Promise<Response | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
