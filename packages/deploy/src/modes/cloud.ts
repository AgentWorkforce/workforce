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
  async launch(_input: ModeLaunchInput): Promise<ModeLaunchHandle> {
    throw new Error(
      '--mode cloud is not yet available: the workforce cloud deployments endpoint is in progress. Use --mode sandbox (Daytona) or --mode dev (local) today.'
    );
  }
};
