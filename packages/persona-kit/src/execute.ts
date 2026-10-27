import {
  applyPersonaMount,
  type ApplyPersonaMountOptions,
  type PersonaMountHandle
} from './mount.js';
import {
  materializePersonaConfigFiles,
  type PersonaConfigFilesHandle
} from './config-files.js';
import { writePersonaSidecars, type PersonaSidecarHandle } from './sidecars.js';
import { runSkillInstalls, type PersonaSkillsHandle } from './skill-runner.js';
import type { PersonaSpawnPlan } from './plan.js';

export interface ExecutionHandle {
  /** The cwd the harness should be spawned in (mount root if mounted). */
  readonly cwd: string;
  /**
   * Reverse every side effect in LIFO order. Idempotent; safe to call twice.
   * Best-effort: a failure inside one disposer does not prevent the others
   * from running.
   */
  dispose(): Promise<void>;
}

export interface ExecuteOptions {
  /** Working directory for skill installs and sidecar writes. */
  cwd: string;
  /**
   * Whether to remove `.claude/skills/` and friends when `dispose()` runs.
   * Default true — leaving someone's repo with a half-installed skills dir
   * after a one-shot spawn is the bigger surprise.
   */
  cleanupSkillsOnDispose?: boolean;
  /**
   * Mount-specific options forwarded to {@link applyPersonaMount} when the
   * plan carries a {@link PersonaSpawnPlan.mount} policy. Required in that
   * case — the executor cannot guess a mountDir.
   */
  mount?: Omit<ApplyPersonaMountOptions, 'cwd'>;
}

interface Disposer {
  dispose(): Promise<void>;
}

async function disposeAll(handles: readonly Disposer[]): Promise<void> {
  for (let i = handles.length - 1; i >= 0; i -= 1) {
    try {
      await handles[i].dispose();
    } catch {
      // Best-effort — keep going so the remaining handles get a chance.
    }
  }
}

/**
 * Run the plan's side effects in deterministic order with abort-on-failure.
 * After this returns successfully, the harness can be spawned at
 * `handle.cwd` with `plan.cli` + `plan.args` and `plan.env`.
 *
 * Order:
 *   1. {@link applyPersonaMount} — mount policy first; everything else
 *      writes into the resulting cwd.
 *   2. {@link runSkillInstalls} — install before sidecars/configFiles so a
 *      failing skill doesn't strand a half-written sidecar on disk.
 *   3. {@link materializePersonaConfigFiles} — opencode.json and friends.
 *   4. {@link writePersonaSidecars} — claudeMd / agentsMd to disk with
 *      restore tracking.
 *
 * If any step throws, prior steps' handles are disposed in LIFO order
 * before the original error propagates. Callers never see partial state.
 */
export async function executePersonaSpawnPlan(
  plan: PersonaSpawnPlan,
  options: ExecuteOptions
): Promise<ExecutionHandle> {
  const handles: Disposer[] = [];
  let mountHandle: PersonaMountHandle | undefined;
  try {
    mountHandle = await applyPersonaMount(plan.mount, {
      cwd: options.cwd,
      personaId: plan.persona.personaId,
      ...(options.mount ?? {})
    });
    handles.push(mountHandle);

    const childCwd = mountHandle.cwd;

    const skillsHandle: PersonaSkillsHandle = await runSkillInstalls(plan.skills, {
      cwd: childCwd,
      cleanupOnDispose: options.cleanupSkillsOnDispose ?? true
    });
    handles.push(skillsHandle);

    const configHandle: PersonaConfigFilesHandle = await materializePersonaConfigFiles(
      plan.configFiles,
      { cwd: childCwd }
    );
    handles.push(configHandle);

    const sidecarHandle: PersonaSidecarHandle = await writePersonaSidecars(
      plan.sidecars,
      { cwd: childCwd }
    );
    handles.push(sidecarHandle);

    let disposed = false;
    return {
      cwd: childCwd,
      async dispose(): Promise<void> {
        if (disposed) return;
        disposed = true;
        await disposeAll(handles);
      }
    };
  } catch (err) {
    await disposeAll(handles);
    throw err;
  }
}
