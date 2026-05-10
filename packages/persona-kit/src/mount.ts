import { createMount } from '@relayfile/local-mount';
import type { ResolvedMountPolicy } from './plan.js';

export interface PersonaMountHandle {
  /**
   * Working directory the harness should be spawned in. When the mount is
   * undefined this is the caller-supplied cwd unchanged; when a mount is
   * applied, this is the per-session mount directory.
   */
  readonly cwd: string;
  /** Tear down the mount. Idempotent; safe to call twice. */
  dispose(): Promise<void>;
}

export interface ApplyPersonaMountOptions {
  /** Directory the harness would otherwise be spawned in. */
  cwd: string;
  /**
   * Absolute path the mount should be created under. Required when a mount
   * policy is supplied. Ignored when `mount` is undefined.
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
 * runs in-place. When `mount` is defined, opens an `@relayfile/local-mount`
 * sandbox under `options.mountDir` and returns a handle whose `cwd` is the
 * mount root. `dispose()` tears the mount down.
 *
 * The caller is responsible for picking the mountDir (typically a
 * per-session scratch directory) and for any auto-sync orchestration outside
 * of mount lifecycle. Persona-kit's mount handle covers open/close only.
 */
export async function applyPersonaMount(
  mount: ResolvedMountPolicy | undefined,
  options: ApplyPersonaMountOptions
): Promise<PersonaMountHandle> {
  if (!mount) {
    let disposed = false;
    return {
      cwd: options.cwd,
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
