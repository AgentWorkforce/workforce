import { readFile, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ResolvedSidecarWrite } from './plan.js';

export interface PersonaSidecarHandle {
  /** Reverse the write. Idempotent; safe to call twice. */
  dispose(): Promise<void>;
}

interface ResoredFile {
  path: string;
  /** Prior contents to restore, or null if the file didn't exist. */
  prior: string | null;
}

const SIDECAR_DELIMITER = '\n\n---\n\n';

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Write each sidecar to `<cwd>/<filename>`. In `extend` mode the persona body
 * is appended to the existing on-disk content (joined with `\n\n---\n\n`). In
 * `overwrite` mode the file is replaced. The returned handle restores every
 * touched file to its prior state on `dispose()`.
 */
export async function writePersonaSidecars(
  sidecars: readonly ResolvedSidecarWrite[],
  options: { cwd: string }
): Promise<PersonaSidecarHandle> {
  const restored: ResoredFile[] = [];
  let disposed = false;
  try {
    for (const sidecar of sidecars) {
      const target = join(options.cwd, sidecar.filename);
      const prior = await readIfExists(target);
      restored.push({ path: target, prior });
      const body =
        sidecar.mode === 'extend' && prior !== null
          ? `${prior}${SIDECAR_DELIMITER}${sidecar.contents}`
          : sidecar.contents;
      await writeFile(target, body, 'utf8');
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

async function disposeRestored(restored: readonly ResoredFile[]): Promise<void> {
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
      // Best-effort restore — losing a file restore must not stop the
      // remaining entries from being processed.
    }
  }
}
