import {
  deploy as deployImpl,
  pickMode,
  type DeployResolvers
} from './deploy.js';
import type { DeployOptions, DeployResult } from './types.js';

export { pickMode, type DeployResolvers };
export { preflightPersona } from './preflight.js';
export {
  connectIntegrations,
  envIntegrationResolver,
  type ConnectAllInput,
  type ConnectAllResult,
  type IntegrationConnectResolver,
  type ProviderSubscriptionResolver
} from './connect.js';
export {
  envWorkspaceAuth,
  loadWorkspaceToken,
  loginWithBrowser,
  resolveWorkspaceToken,
  resolveWorkspaceTokenFromEnv,
  storeWorkspaceToken,
  type StoredWorkspaceLogin,
  type WorkspaceAuth,
  type WorkspaceAuthToken
} from './login.js';
export { createTerminalIO, createBufferedIO, type BufferedIO } from './io.js';
export { bundleStager } from './bundle.js';
export { devLauncher } from './modes/dev.js';
export { sandboxLauncher, resolveSandboxAuth, type SandboxAuth } from './modes/sandbox.js';
export { cloudLauncher } from './modes/cloud.js';

export type {
  BundleResult,
  BundleStageInput,
  BundleStager,
  DeployIO,
  DeployMode,
  DeployOptions,
  DeployPreflight,
  DeployResult,
  IntegrationConnectOutcome,
  ModeLaunchHandle,
  ModeLaunchInput,
  ModeLauncher
} from './types.js';

export async function deploy(
  opts: DeployOptions,
  resolvers: DeployResolvers = {}
): Promise<DeployResult> {
  return await deployImpl(opts, resolvers);
}
