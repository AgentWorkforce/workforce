import { spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { buildInstallArtifacts } from './skills.js';
import type { SkillMaterializationPlan } from './types.js';

export interface PersonaSkillsHandle {
  /**
   * Remove the per-install ephemeral artifact paths declared by the plan
   * (or, in session mode, the whole session install root). Idempotent.
   */
  dispose(): Promise<void>;
}

export interface RunSkillInstallsOptions {
  cwd: string;
  /**
   * When true (default) the dispose handle deletes installed skills paths
   * (or, in session mode, the entire session install root). Set false to
   * keep installs around — e.g. for repeat runs that share a stage dir.
   */
  cleanupOnDispose?: boolean;
}

export class SkillInstallError extends Error {
  readonly exitCode: number;
  readonly output: string;
  constructor(exitCode: number, output: string) {
    super(`Skill install failed (exit ${exitCode})`);
    this.name = 'SkillInstallError';
    this.exitCode = exitCode;
    this.output = output;
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (!signal) return 0;
  const num = (osConstants.signals as Record<string, number | undefined>)[signal];
  return 128 + (num ?? 1);
}

async function spawnInstall(
  command: readonly string[],
  cwd: string
): Promise<{ code: number; output: string }> {
  const [bin, ...args] = command;
  if (!bin) return { code: 0, output: '' };
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
      cwd
    });
    let buffered = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      buffered += chunk;
    });
    child.stderr?.on('data', (chunk: string) => {
      buffered += chunk;
    });
    child.on('error', (err) => {
      resolve({ code: 1, output: `${buffered}${err.message}\n` });
    });
    child.on('close', (status, signal) => {
      const exit =
        typeof status === 'number' ? status : signal ? signalExitCode(signal) : 1;
      resolve({ code: exit, output: buffered });
    });
  });
}

/**
 * Run every install in a {@link SkillMaterializationPlan}. Aborts on the
 * first non-zero exit code with the buffered subprocess output attached to
 * the thrown error. The returned handle removes the installed artifacts on
 * `dispose()` (or the whole session root in session-install-root mode).
 */
export async function runSkillInstalls(
  plan: SkillMaterializationPlan,
  options: RunSkillInstallsOptions
): Promise<PersonaSkillsHandle> {
  const cleanupOnDispose = options.cleanupOnDispose ?? true;
  const artifacts = buildInstallArtifacts(plan);
  if (artifacts.installCommandString !== ':') {
    const { code, output } = await spawnInstall(artifacts.installCommand, options.cwd);
    if (code !== 0) {
      throw new SkillInstallError(code, output);
    }
  }

  let disposed = false;
  return {
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      if (!cleanupOnDispose) return;
      if (plan.sessionInstallRoot !== undefined) {
        await rm(plan.sessionInstallRoot, { recursive: true, force: true });
        return;
      }
      const cwdAbs = resolve(options.cwd);
      for (const install of plan.installs) {
        for (const path of install.cleanupPaths) {
          const abs = isAbsolute(path) ? resolve(path) : resolve(cwdAbs, path);
          const rel = relative(cwdAbs, abs);
          // Refuse to follow a tampered plan into directories outside the
          // workspace — `rm -rf` doesn't get a free pass just because the
          // path was declared in plan data.
          if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
            throw new Error(
              `runSkillInstalls: cleanup path must stay within cwd; got ${JSON.stringify(path)}`
            );
          }
          await rm(abs, { recursive: true, force: true });
        }
      }
    }
  };
}
