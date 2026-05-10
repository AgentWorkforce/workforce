import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import type { InteractiveConfigFile } from './interactive-spec.js';

export interface PersonaConfigFilesHandle {
  /** Reverse every config-file write. Idempotent. */
  dispose(): Promise<void>;
}

interface RestoredFile {
  path: string;
  prior: string | null;
}

/**
 * Reject paths that would escape the cwd or hit absolute targets — same
 * policy as the CLI's existing `assertSafeRelativePath` so persona-kit's
 * exec helpers can be plugged into the CLI later without weakening the
 * sandbox guarantees.
 */
export function assertSafeRelativePath(relPath: string): void {
  if (!relPath) {
    throw new Error('configFile path must be a non-empty relative path');
  }
  if (isAbsolute(relPath)) {
    throw new Error(
      `configFile path must be relative; got absolute path ${JSON.stringify(relPath)}`
    );
  }
  const segments = relPath.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) {
    throw new Error(
      `configFile path must not contain ".." segments; got ${JSON.stringify(relPath)}`
    );
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Materialize each {@link InteractiveConfigFile} under `options.cwd`,
 * creating any missing parent directories. The returned handle restores
 * each touched path to its prior state on `dispose()`.
 */
export async function materializePersonaConfigFiles(
  configFiles: readonly InteractiveConfigFile[],
  options: { cwd: string }
): Promise<PersonaConfigFilesHandle> {
  const restored: RestoredFile[] = [];
  let disposed = false;
  try {
    for (const file of configFiles) {
      assertSafeRelativePath(file.path);
      const target = join(options.cwd, file.path);
      const prior = await readIfExists(target);
      restored.push({ path: target, prior });
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, file.contents, 'utf8');
    }
  } catch (err) {
    await disposeRestored(restored);
    throw err;
  }
  return {
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await disposeRestored(restored);
    }
  };
}

async function disposeRestored(restored: readonly RestoredFile[]): Promise<void> {
  for (let i = restored.length - 1; i >= 0; i -= 1) {
    const entry = restored[i];
    try {
      if (entry.prior === null) {
        await unlink(entry.path).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        });
      } else {
        await writeFile(entry.path, entry.prior, 'utf8');
      }
    } catch {
      // Best-effort.
    }
  }
}
