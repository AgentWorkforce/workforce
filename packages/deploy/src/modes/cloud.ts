import { readFile } from 'node:fs/promises';
import type {
  ModeLaunchInput,
  ModeLaunchHandle,
  ModeLauncher
} from '../types.js';

/**
 * Workforce-cloud-hosted deploy mode. Uploads the bundle to the workforce
 * cloud deployments endpoint and lets the cloud runtime host the agent.
 *
 * The endpoint (`POST /api/v1/workspaces/:id/deployments`) is part of the
 * proactive-runtime backend roadmap and is not yet live. Until it is,
 * `--mode cloud` returns a clean error that points users at the working
 * modes (`--mode sandbox` and `--mode dev`).
 *
 * When the endpoint ships, the implementation flow is:
 *   1. POST persona.json + agent.bundle.mjs + runner.mjs as multipart.
 *   2. Receive `{ deploymentId, statusUrl }`.
 *   3. Poll `statusUrl` until the cloud reports `running`.
 *   4. Return a handle whose `stop()` calls DELETE on the deployment.
 */
export const cloudLauncher: ModeLauncher = {
  async launch(input: ModeLaunchInput): Promise<ModeLaunchHandle> {
    const cloudUrl = (input.cloudUrl ?? process.env.WORKFORCE_CLOUD_URL)?.replace(/\/$/, '');
    const token = process.env.WORKFORCE_WORKSPACE_TOKEN;
    if (cloudUrl && token) {
      return postCloudDeployment(input, cloudUrl, token);
    }
    throw new Error(
      '--mode cloud is not yet available: the workforce cloud deployments endpoint is in progress. Use --mode sandbox (Daytona) or --mode dev (local) today.'
    );
  }
};

async function postCloudDeployment(
  input: ModeLaunchInput,
  cloudUrl: string,
  workspaceToken: string
): Promise<ModeLaunchHandle> {
  const res = await fetch(
    `${cloudUrl}/api/v1/workspaces/${encodeURIComponent(input.workspace)}/deployments`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${workspaceToken}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        persona: input.persona,
        bundle: {
          runner: await readFile(input.bundle.runnerPath, 'utf8'),
          agent: await readFile(input.bundle.bundlePath, 'utf8'),
          packageJson: JSON.parse(await readFile(input.bundle.packageJsonPath, 'utf8'))
        },
        ...(input.inputs && Object.keys(input.inputs).length > 0 ? { inputs: input.inputs } : {})
      })
    }
  );
  if (!res.ok) {
    throw new Error(`Cloud deploy failed: ${res.status} ${await res.text()}`);
  }
  const body = (await res.json()) as {
    agentId?: string;
    deploymentId?: string;
    status?: string;
  };
  const id = body.deploymentId ?? body.agentId;
  if (!id) {
    throw new Error(`Cloud deploy failed: response missing deploymentId/agentId`);
  }
  input.io.info(`cloud: ${body.status ?? 'submitted'}`);
  return {
    id,
    async stop() {
      throw new Error('cloud deployment stop is not wired yet');
    },
    done: Promise.resolve({ code: body.status === 'failed' ? 1 : 0 })
  };
}
