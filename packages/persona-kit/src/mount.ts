import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { AutoSyncHandle, AutoSyncOptions } from '@relayfile/local-mount';
import type { ResolvedMountPolicy, ResolvedMountRoot } from './plan.js';

// `@relayfile/local-mount` pulls in `@parcel/watcher`, which loads a
// per-platform native binary at module evaluation time
// (`@parcel/watcher-linux-x64-glibc`, `-darwin-arm64`, …). When
// persona-kit is loaded server-side just to call `parsePersonaSpec`
// (e.g. cloud's `import('@agentworkforce/persona-kit')` to validate a
// deploy bundle), eagerly importing local-mount fails any host that
// doesn't ship a matching prebuild — most notably AWS Lambda's
// `@parcel/watcher-linux-x64-glibc`, which OpenNext doesn't bundle.
//
// Deferring the local-mount import to `applyPersonaMount`'s call site
// means the native binary only loads when a mount is actually being
// applied (which is a CLI/runtime concern, never a server-side
// validation concern).
async function loadCreateMount(): Promise<typeof import('@relayfile/local-mount').createMount> {
  const mod = await import('@relayfile/local-mount');
  return mod.createMount;
}

export interface PersonaMountHandle {
  /**
   * Working directory the harness should be spawned in. When the mount is
   * undefined this is the caller-supplied cwd unchanged; when a mount is
   * applied, this is the per-session mount directory.
   *
   * For multi-root mounts this is the parent directory that holds each
   * root as a subdirectory keyed by alias (`<cwd>/<alias>/...`).
   */
  readonly cwd: string;
  /**
   * Resolved aliases this handle owns, in declaration order. Empty for
   * single-root and no-op handles; populated for multi-root mounts so
   * callers can reason about the on-disk layout (e.g. `cwd/<alias>`).
   */
  readonly aliases: readonly string[];
  /** Tear down the mount. Idempotent; safe to call twice. */
  dispose(): Promise<void>;
}

export interface ApplyPersonaMountOptions {
  /** Directory the harness would otherwise be spawned in. */
  cwd: string;
  /**
   * Absolute path the mount should be created under. Required when a mount
   * policy is supplied. Ignored when `mount` is undefined.
   *
   * - Single-root mounts: this is the mount root itself.
   * - Multi-root mounts: this is the parent that holds each root as a
   *   subdirectory; relayfile's `createMount` runs for each root with
   *   destination `<mountDir>/<alias>`.
   */
  mountDir?: string;
  /**
   * Persona id used to label the mount's per-session `.git` worktree (when
   * `includeGit` is true). Required when a mount policy is supplied.
   */
  personaId?: string;
  /**
   * Whether to mirror the project's `.git` into the mount. Defaults to true
   * so git commands work inside the sandbox; set false when callers want a
   * pure file overlay.
   */
  includeGit?: boolean;
  /**
   * Keep the project and mount synchronized for the lifetime of the handle.
   * `dispose()` stops the watchers and performs their final flush before the
   * mount is removed.
   */
  autoSync?: boolean | AutoSyncOptions;
}

/**
 * Apply the persona's mount policy. When `mount` is undefined, returns a
 * no-op handle whose `cwd` is the caller-supplied directory — the harness
 * runs in-place. When `mount` is defined:
 *
 *   - Without `roots`, opens a single `@relayfile/local-mount` sandbox over
 *     `options.cwd` at `options.mountDir` (legacy behavior, unchanged).
 *   - With `roots`, opens one mount per root at `<mountDir>/<alias>` and
 *     returns a handle whose `cwd` is the parent `mountDir`. Each root's
 *     `ignoredPatterns` / `readonlyPatterns` extend the policy-level lists.
 *     Per-mount source is the resolved absolute path from the persona spec,
 *     so `options.cwd` is ignored for the multi-root case (multi-root
 *     personas don't depend on where the launcher was invoked from).
 *
 * `dispose()` tears everything down in reverse open order, best-effort.
 * When `options.autoSync` is set, each root (or the single mount) starts
 * a watcher that `dispose()` stops before cleanup. The caller picks the
 * mountDir, typically a per-session scratch directory.
 */
export async function applyPersonaMount(
  mount: ResolvedMountPolicy | undefined,
  options: ApplyPersonaMountOptions
): Promise<PersonaMountHandle> {
  if (!mount) {
    let disposed = false;
    return {
      cwd: options.cwd,
      aliases: [],
      async dispose(): Promise<void> {
        disposed = true;
        return;
      }
    };
  }
  if (!options.mountDir) {
    throw new Error(
      'applyPersonaMount: options.mountDir is required when a mount policy is supplied'
    );
  }
  if (!options.personaId) {
    throw new Error(
      'applyPersonaMount: options.personaId is required when a mount policy is supplied'
    );
  }
  const createMount = await loadCreateMount();

  if (mount.roots && mount.roots.length > 0) {
    return openMultiRoot(createMount, mount, options);
  }

  const handle = await createMount(options.cwd, options.mountDir, {
    ignoredPatterns: [...mount.ignoredPatterns],
    readonlyPatterns: [...mount.readonlyPatterns],
    excludeDirs: [],
    agentName: options.personaId,
    includeGit: options.includeGit ?? true
  });
  let autoSync: AutoSyncHandle | undefined;
  try {
    autoSync = options.autoSync
      ? handle.startAutoSync(typeof options.autoSync === 'object' ? options.autoSync : undefined)
      : undefined;
  // Do not hand the mount to a fast-starting harness before watcher setup has
  // settled. A degraded watcher is still usable: stop() performs a full
  // reconcile, so setup errors intentionally fall through to that fallback.
    await Promise.resolve(autoSync?.ready()).catch(() => undefined);
  } catch (error) {
    await handle.cleanup();
    throw error;
  }

  let disposed = false;
  return {
    cwd: handle.mountDir,
    aliases: [],
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      try {
        await autoSync?.stop();
      } finally {
        // Defensive await — relayfile's typed signature is void today, but
        // future versions may return a promise; awaiting a non-promise is a
        // no-op and protects the dispose contract executors rely on.
        await handle.cleanup();
      }
    }
  };
}

interface OpenedRoot {
  handle: {
    mountDir: string;
    cleanup(): void | Promise<void>;
  };
  autoSync?: AutoSyncHandle;
}

async function openMultiRoot(
  createMount: Awaited<ReturnType<typeof loadCreateMount>>,
  mount: ResolvedMountPolicy,
  options: ApplyPersonaMountOptions
): Promise<PersonaMountHandle> {
  if (!options.mountDir) {
    // Already guarded above, repeated here for the type narrowing.
    throw new Error('applyPersonaMount: options.mountDir is required');
  }
  const roots = mount.roots;
  if (!roots || roots.length === 0) {
    throw new Error('applyPersonaMount: multi-root mount requires at least one root');
  }
  const parent = options.mountDir;
  await mkdir(parent, { recursive: true });

  const opened: OpenedRoot[] = [];
  const aliases: string[] = [];
  try {
    for (const root of roots) {
      const dest = join(parent, root.alias);
      const handle = await createMount(root.path, dest, {
        ignoredPatterns: mergePatterns(mount.ignoredPatterns, root.ignoredPatterns),
        readonlyPatterns: mergePatterns(mount.readonlyPatterns, root.readonlyPatterns),
        excludeDirs: [],
        agentName: `${options.personaId}:${root.alias}`,
        includeGit: options.includeGit ?? true
      });
      let autoSync: AutoSyncHandle | undefined;
      try {
        autoSync = options.autoSync
          ? handle.startAutoSync(typeof options.autoSync === 'object' ? options.autoSync : undefined)
          : undefined;
        await Promise.resolve(autoSync?.ready()).catch(() => undefined);
      } catch (error) {
        await handle.cleanup();
        throw error;
      }
      opened.push({ handle, autoSync });
      aliases.push(root.alias);
    }
  } catch (err) {
    await disposeAll(opened);
    throw err;
  }

  let disposed = false;
  return {
    cwd: parent,
    aliases,
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      await disposeAll(opened);
    }
  };
}

function mergePatterns(
  base: readonly string[],
  extra: readonly string[] | undefined
): string[] {
  if (!extra || extra.length === 0) return [...base];
  return [...base, ...extra];
}

async function disposeAll(opened: readonly OpenedRoot[]): Promise<void> {
  for (let i = opened.length - 1; i >= 0; i -= 1) {
    try {
      await opened[i].autoSync?.stop();
    } catch {
      // Best-effort: one failed watcher stop must not block the rest.
    }
    try {
      await opened[i].handle.cleanup();
    } catch {
      // Best-effort: one failed cleanup must not block the rest.
    }
  }
}

/**
 * Resolved roots for callers that orchestrate their own relayfile lifecycle
 * (e.g. the CLI's spinner/SIGINT/autosync stack). Re-exported here so call
 * sites do not need to reach into `plan.js` just for the root shape.
 */
export type { ResolvedMountRoot };
