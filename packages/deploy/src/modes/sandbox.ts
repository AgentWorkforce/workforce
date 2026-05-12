import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Daytona, type Sandbox } from '@daytonaio/sdk';
import type {
  ModeLaunchInput,
  ModeLaunchHandle,
  ModeLauncher
} from '../types.js';

/**
 * Working directory the runner is invoked from inside the sandbox. Same
 * mount root cloud's DaytonaRuntime defaults to, so persona authors get
 * consistent paths whether they run under workforce or cloud workflows.
 */
const SANDBOX_BUNDLE_DIR = '/home/daytona/bundle';

/**
 * Daytona authentication resolved before sandbox creation. Workforce
 * supports two paths:
 *
 *   - BYO  — `DAYTONA_API_KEY` (+ optional `DAYTONA_ORGANIZATION_ID`)
 *            in the user's env. Zero workforce-cloud roundtrips.
 *   - Workforce-managed — a workspace token mints a Daytona JWT against
 *            the workforce cloud API (`POST /workspaces/:id/sandboxes`).
 *            Lights up once the cloud endpoint ships.
 */
export interface SandboxAuth {
  apiKey?: string;
  jwtToken?: string;
  organizationId?: string;
}

export function resolveSandboxAuth(): SandboxAuth | undefined {
  const apiKey = process.env.DAYTONA_API_KEY;
  const jwtToken = process.env.DAYTONA_JWT_TOKEN;
  const organizationId = process.env.DAYTONA_ORGANIZATION_ID;
  if (!apiKey && !jwtToken) return undefined;
  return {
    ...(apiKey ? { apiKey } : {}),
    ...(jwtToken ? { jwtToken } : {}),
    ...(organizationId ? { organizationId } : {})
  };
}

/**
 * Daytona-backed sandbox launcher. Creates a TypeScript sandbox, uploads
 * the bundle, and starts the runner with a long timeout (effectively
 * unlimited for cron-driven agents). The sandbox stays alive after the
 * exec call returns so subsequent envelopes the runner expects on stdin
 * have a place to land — see `stop()` for the explicit teardown contract.
 *
 * Streaming: Daytona's `executeCommand` is final-result-only. The runner
 * exits when its envelope stream ends, and the resulting stdout/stderr
 * blob is forwarded to the DeployIO at that point. Live tail support
 * would require `process.createSession`, which is gated on a future
 * iteration.
 */
export const sandboxLauncher: ModeLauncher = {
  async launch(input: ModeLaunchInput): Promise<ModeLaunchHandle> {
    const auth = resolveSandboxAuth();
    if (!auth) {
      throw new Error(
        'sandbox launcher: no Daytona credentials resolved. Either export DAYTONA_API_KEY (BYO) or run `workforce login` to mint a workforce-managed Daytona token.'
      );
    }

    const daytona = new Daytona(auth);
    const sandbox = await daytona.create({
      language: 'typescript',
      name: `wf-${input.persona.id}`,
      envVars: {
        ...(input.env ?? {}),
        WORKFORCE_WORKSPACE_ID: input.workspace,
        WORKFORCE_PERSONA_ID: input.persona.id
      }
    });

    try {
      await uploadBundle(sandbox, input);
    } catch (err) {
      // If upload fails, the sandbox is unrecoverable for this deploy.
      // Tear it down so we don't leak Daytona resources.
      await sandbox.delete().catch(() => undefined);
      throw err;
    }

    const sandboxTimeoutSeconds = resolveTimeoutSeconds(input.persona.sandbox);

    let stopping = false;
    let runner: Promise<{ code: number }> | undefined;

    const stop = async (): Promise<void> => {
      if (stopping) return;
      stopping = true;
      try {
        await sandbox.delete();
      } catch (err) {
        input.io.warn(
          `sandbox: cleanup failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    };

    runner = (async () => {
      try {
        const result = await sandbox.process.executeCommand(
          'node runner.mjs',
          SANDBOX_BUNDLE_DIR,
          undefined,
          sandboxTimeoutSeconds
        );
        const output = (result.result ?? '').trim();
        if (output.length > 0) input.io.info(`[sandbox] ${output}`);
        const exitCode = result.exitCode ?? 0;
        return { code: exitCode };
      } catch (err) {
        if (!stopping) {
          input.io.error(
            `sandbox: runner exec failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return { code: 1 };
      }
    })();

    return {
      id: `sandbox:${sandbox.id}`,
      stop,
      done: runner
    };
  }
};

async function uploadBundle(sandbox: Sandbox, input: ModeLaunchInput): Promise<void> {
  // Bundle artifacts are tiny (KB-range), so reading them into Buffers
  // before upload is the simplest correct shape. If/when bundles grow to
  // the MB range we revisit streaming.
  const files = await Promise.all([
    fileUpload(input.bundle.runnerPath, `${SANDBOX_BUNDLE_DIR}/runner.mjs`),
    fileUpload(input.bundle.bundlePath, `${SANDBOX_BUNDLE_DIR}/agent.bundle.mjs`),
    fileUpload(input.bundle.personaCopyPath, `${SANDBOX_BUNDLE_DIR}/persona.json`),
    fileUpload(input.bundle.packageJsonPath, `${SANDBOX_BUNDLE_DIR}/package.json`)
  ]);
  await sandbox.fs.uploadFiles(files);

  // The bundle's package.json declares `@agentworkforce/runtime` as a
  // dependency. The sandbox starts from a clean tsx baseline, so we
  // resolve the runtime via `npm install` before the runner can import
  // it. Install runs once per sandbox lifetime; long-lived agents
  // pay the cost only at cold-start.
  const install = await sandbox.process.executeCommand(
    'npm install --prefer-offline --no-audit --no-fund --loglevel=error @agentworkforce/runtime@latest',
    SANDBOX_BUNDLE_DIR,
    undefined,
    600
  );
  if ((install.exitCode ?? 0) !== 0) {
    throw new Error(
      `sandbox: npm install failed (exit ${install.exitCode}): ${install.result?.slice(0, 400) ?? ''}`
    );
  }
}

async function fileUpload(localPath: string, remotePath: string): Promise<{ source: Buffer; destination: string }> {
  const source = await readFile(localPath);
  return { source, destination: remotePath };
}

function resolveTimeoutSeconds(sandbox: ModeLaunchInput['persona']['sandbox']): number | undefined {
  if (sandbox === undefined || sandbox === true || sandbox === false) return undefined;
  if (typeof sandbox.timeoutSeconds === 'number' && sandbox.timeoutSeconds > 0) {
    return sandbox.timeoutSeconds;
  }
  return undefined;
}
