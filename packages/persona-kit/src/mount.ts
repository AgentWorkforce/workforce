import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
 * The caller is responsible for picking the mountDir (typically a
 * per-session scratch directory) and for any auto-sync orchestration
 * outside of mount lifecycle. Persona-kit's mount handle covers
 * open/close only.
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

  let disposed = false;
  return {
    cwd: handle.mountDir,
    aliases: [],
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      // Defensive await — relayfile's typed signature is void today, but
      // future versions may return a promise; awaiting a non-promise is a
      // no-op and protects the dispose contract executors rely on.
      await handle.cleanup();
    }
  };
}

interface RelayfileHandle {
  mountDir: string;
  cleanup(): void | Promise<void>;
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
  const parent = options.mountDir;
  await mkdir(parent, { recursive: true });

  const opened: RelayfileHandle[] = [];
  const aliases: string[] = [];
  try {
    for (const root of mount.roots ?? []) {
      const dest = join(parent, root.alias);
      const handle = await createMount(root.path, dest, {
        ignoredPatterns: mergePatterns(mount.ignoredPatterns, root.ignoredPatterns),
        readonlyPatterns: mergePatterns(mount.readonlyPatterns, root.readonlyPatterns),
        excludeDirs: [],
        agentName: `${options.personaId}:${root.alias}`,
        includeGit: options.includeGit ?? true
      });
      opened.push(handle);
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

async function disposeAll(handles: readonly RelayfileHandle[]): Promise<void> {
  for (let i = handles.length - 1; i >= 0; i -= 1) {
    try {
      await handles[i].cleanup();
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
