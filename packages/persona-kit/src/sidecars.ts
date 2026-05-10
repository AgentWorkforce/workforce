import { readFile, writeFile, unlink } from 'node:fs/promises';
import { basename, isAbsolute, join } from 'node:path';
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

/**
 * The plan's filename is typed `'CLAUDE.md' | 'AGENTS.md'` at compile time,
 * but plans can be JSON-deserialized from untrusted sources at runtime.
 * Bound to safe basenames here so a hand-built or tampered plan cannot
 * escape `cwd` via `..` or absolute path segments.
 */
function assertSafeSidecarFilename(filename: string): void {
  if (!filename) throw new Error('sidecar filename must be non-empty');
  if (isAbsolute(filename)) {
    throw new Error(
      `sidecar filename must be relative; got ${JSON.stringify(filename)}`
    );
  }
  if (basename(filename) !== filename) {
    throw new Error(
      `sidecar filename must be a basename (no directory segments); got ${JSON.stringify(filename)}`
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

async function loadSidecarBody(sidecar: ResolvedSidecarWrite): Promise<string> {
  if (sidecar.contents !== undefined) return sidecar.contents;
  if (sidecar.sourcePath !== undefined) {
    if (!isAbsolute(sidecar.sourcePath)) {
      throw new Error(
        `ResolvedSidecarWrite.sourcePath must be absolute; got ${JSON.stringify(sidecar.sourcePath)}`
      );
    }
    return readFile(sidecar.sourcePath, 'utf8');
  }
  // Type system already enforces this; the runtime check keeps the message
  // clear if a hand-built plan slips through.
  const probe = sidecar as { filename?: string };
  throw new Error(
    `ResolvedSidecarWrite for ${probe.filename ?? '<unknown>'} must supply either contents or sourcePath.`
  );
}

/**
 * Write each sidecar to `<cwd>/<filename>`. In `extend` mode the persona body
 * is appended to the existing on-disk content (joined with `\n\n---\n\n`). In
 * `overwrite` mode the file is replaced. Path-backed sidecars
 * ({@link ResolvedSidecarWrite.sourcePath}) are read at this point, so the
 * plan stays JSON-serializable. The returned handle restores every touched
 * file to its prior state on `dispose()`.
 */
export async function writePersonaSidecars(
  sidecars: readonly ResolvedSidecarWrite[],
  options: { cwd: string }
): Promise<PersonaSidecarHandle> {
  const restored: ResoredFile[] = [];
  let disposed = false;
  try {
    for (const sidecar of sidecars) {
      assertSafeSidecarFilename(sidecar.filename);
      const target = join(options.cwd, sidecar.filename);
      const personaBody = await loadSidecarBody(sidecar);
      const prior = await readIfExists(target);
      restored.push({ path: target, prior });
      const body =
        sidecar.mode === 'extend' && prior !== null
          ? `${prior}${SIDECAR_DELIMITER}${personaBody}`
          : personaBody;
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
