import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdir, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type {
  ModeLaunchInput,
  ModeLaunchHandle,
  ModeLauncher
} from '../types.js';
import { runtimeContextEnv } from '../runtime-context.js';

const SIGTERM_TO_SIGKILL_MS = 5_000;

const RUNTIME_PACKAGES = ['@agentworkforce/runtime', '@agentworkforce/persona-kit'] as const;

/**
 * Local dev-mode launcher. Spawns `node <bundle.runnerPath>` as a child
 * process, forwards line-buffered stdout/stderr through the supplied
 * DeployIO, and resolves `done` when the child exits.
 *
 * `stop()` sends SIGTERM and escalates to SIGKILL after 5s if the child
 * hasn't exited cleanly. The parent's SIGINT/SIGTERM are forwarded too
 * so Ctrl-C in `--mode dev` produces an orderly shutdown.
 */
export const devLauncher: ModeLauncher = {
  async launch(input: ModeLaunchInput): Promise<ModeLaunchHandle> {
    const runnerPath = input.bundle.runnerPath;
    const cwd = path.dirname(runnerPath);

    // The generated runner imports `@agentworkforce/runtime`. In dev
    // mode we resolve the package out of the parent workforce install
    // and symlink it into the bundle's local node_modules so node's
    // ESM resolver finds it without an `npm install` step. The link is
    // idempotent: stale links are replaced on every launch.
    await linkRuntimePackages(cwd);

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...(input.env ?? {}),
      ...runtimeContextEnv(input.persona, input.env, input.agent),
      WORKFORCE_WORKSPACE_ID: input.workspace,
      WORKFORCE_PERSONA_ID: input.persona.id
    };

    const child = spawn(process.execPath, [runnerPath], {
      cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    // Bridge the parent process's stdin into the child runner. The
    // runner reads NDJSON envelopes from its stdin, so any envelopes the
    // user pipes into `workforce deploy --mode dev` flow straight into
    // the runner without an intermediate file.
    if (child.stdin) {
      process.stdin.pipe(child.stdin);
      // When the parent's stdin closes (EOF / piped input drained), end
      // the child's stdin too so the runner's for-await loop terminates.
      process.stdin.once('end', () => {
        child.stdin?.end();
      });
    }

    if (child.pid === undefined) {
      throw new Error('dev launcher: failed to spawn runner (no pid assigned)');
    }

    forwardLines(child.stdout, (line) => input.io.info(`[runtime] ${line}`));
    forwardLines(child.stderr, (line) => input.io.warn(`[runtime] ${line}`));

    const done = new Promise<{ code: number }>((resolveDone) => {
      child.once('exit', (code, signal) => {
        const exitCode = typeof code === 'number' ? code : signal ? signalExit(signal) : 0;
        resolveDone({ code: exitCode });
      });
    });

    let stopping = false;
    const stop = async (): Promise<void> => {
      if (stopping) {
        await done;
        return;
      }
      stopping = true;
      child.stdin?.end();
      child.kill('SIGTERM');
      // `child.killed` flips true the moment `kill()` delivers the signal,
      // regardless of whether the child has actually exited. To detect a
      // stuck child we have to look at the real lifecycle markers — both
      // exitCode and signalCode stay null until the OS reaps the process.
      const escalation = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
        }
      }, SIGTERM_TO_SIGKILL_MS).unref();
      try {
        await done;
      } finally {
        clearTimeout(escalation);
      }
    };

    // Bridge parent-process signal handlers so Ctrl-C in --mode dev
    // produces a clean child shutdown (and not an orphaned runner).
    const forwardParentSignal = (signal: NodeJS.Signals) => {
      void stop().catch(() => {
        /* stop already drained */
      });
      process.off('SIGINT', forwardParentSignal as never);
      process.off('SIGTERM', forwardParentSignal as never);
      // Re-raise so the parent's normal exit semantics take over after
      // the child closes down.
      process.kill(process.pid, signal);
    };
    process.once('SIGINT', forwardParentSignal);
    process.once('SIGTERM', forwardParentSignal);

    return {
      id: `pid:${child.pid}`,
      stop,
      done
    };
  }
};

function forwardLines(stream: Readable, write: (line: string) => void): void {
  let buffered = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffered += chunk;
    let nl = buffered.indexOf('\n');
    while (nl !== -1) {
      const line = buffered.slice(0, nl).replace(/\r$/, '');
      buffered = buffered.slice(nl + 1);
      if (line.length > 0) write(line);
      nl = buffered.indexOf('\n');
    }
  });
  stream.on('end', () => {
    const tail = buffered.trim();
    if (tail.length > 0) write(tail);
  });
}

async function linkRuntimePackages(bundleDir: string): Promise<void> {
  const nodeModulesDir = path.join(bundleDir, 'node_modules');
  const scopeDir = path.join(nodeModulesDir, '@agentworkforce');
  await mkdir(scopeDir, { recursive: true });

  // Resolve each package's installed root by asking node where its
  // `package.json` lives, then symlink that root into our bundle's
  // node_modules. Using `require.resolve` guarantees we point at the
  // package the deploy package itself imports — no env var dance.
  const localRequire = createRequire(import.meta.url);
  for (const pkg of RUNTIME_PACKAGES) {
    const manifestPath = localRequire.resolve(`${pkg}/package.json`);
    const packageRoot = path.dirname(manifestPath);
    const linkPath = path.join(scopeDir, pkg.slice('@agentworkforce/'.length));
    await rm(linkPath, { recursive: true, force: true });
    await symlink(packageRoot, linkPath, 'dir');
  }
}

function signalExit(signal: NodeJS.Signals): number {
  // Match the POSIX convention for terminated children.
  const SIGNAL_MAP: Partial<Record<NodeJS.Signals, number>> = {
    SIGINT: 130,
    SIGTERM: 143,
    SIGKILL: 137,
    SIGHUP: 129
  };
  return SIGNAL_MAP[signal] ?? 1;
}
