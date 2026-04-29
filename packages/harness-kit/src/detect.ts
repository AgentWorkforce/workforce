import { spawnSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { delimiter, join } from 'node:path';

import { HARNESS_VALUES, type Harness } from '@agentworkforce/workload-router';

/**
 * Result of probing a harness binary on the caller's machine.
 *
 * `available` is true iff the binary was found on PATH *and* responded to
 * `--version` with exit code 0. `path` is populated whenever we located the
 * binary, even if it failed to run — useful for diagnosing a broken install
 * vs. a missing one.
 */
export interface HarnessAvailability {
  harness: Harness;
  available: boolean;
  version?: string;
  path?: string;
  error?: string;
}

function findOnPath(bin: string): string | undefined {
  const pathEnv = process.env.PATH ?? '';
  const pathExt =
    process.platform === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
      : [''];
  for (const dir of pathEnv.split(delimiter)) {
    if (!dir) continue;
    for (const ext of pathExt) {
      const candidate = join(dir, bin + ext);
      try {
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        // Not found or unreadable; keep scanning.
      }
    }
  }
  return undefined;
}

/**
 * Probe a single harness binary: locate it on PATH and run `<bin> --version`.
 * Returns a typed availability record — never throws.
 */
export function detectHarness(
  harness: Harness,
  options: { timeoutMs?: number } = {}
): HarnessAvailability {
  const timeoutMs = options.timeoutMs ?? 3000;
  const path = findOnPath(harness);
  if (!path) {
    return { harness, available: false, error: 'not found on PATH' };
  }
  const res = spawnSync(harness, ['--version'], {
    timeout: timeoutMs,
    encoding: 'utf8',
    shell: false
  });
  if (res.error) {
    return { harness, available: false, path, error: res.error.message };
  }
  if (res.status !== 0) {
    const combined = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
    const firstLine = combined.split('\n')[0];
    return {
      harness,
      available: false,
      path,
      error: `--version exited ${res.status}${firstLine ? `: ${firstLine}` : ''}`
    };
  }
  const version =
    (res.stdout ?? '').trim().split('\n')[0] ||
    (res.stderr ?? '').trim().split('\n')[0] ||
    undefined;
  return { harness, available: true, path, version };
}

/** Probe every known harness in `HARNESS_VALUES`. */
export function detectHarnesses(
  options: { timeoutMs?: number } = {}
): HarnessAvailability[] {
  return HARNESS_VALUES.map((h) => detectHarness(h, options));
}
