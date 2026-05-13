import {
  deploy as deployInternal,
  pickMode,
  type DeployResolvers
} from './deploy.js';
import { preflightPersona } from './preflight.js';
import { devLauncher } from './modes/dev.js';
import { sandboxLauncher } from './modes/sandbox.js';
import { cloudLauncher } from './modes/cloud.js';
import type {
  DeployOptions,
  DeployResult,
  ModeLaunchInput,
  ModeLauncher
} from './types.js';

export { pickMode, type DeployResolvers };
export { preflightPersona };
export {
  connectIntegrations,
  envIntegrationResolver,
  relayfileIntegrationResolver,
  type ConnectAllInput,
  type ConnectAllResult,
  type IntegrationConnectResolver,
  type ProviderSubscriptionResolver
} from './connect.js';
export {
  clearActiveWorkspace,
  clearStoredWorkspaceToken,
  envWorkspaceAuth,
  loadActiveWorkspaceToken,
  loadWorkspaceToken,
  readActiveWorkspace,
  resolveWorkspaceToken,
  resolveWorkspaceTokenFromEnv,
  storeWorkspaceToken,
  writeActiveWorkspace,
  writeStoredWorkspaceToken,
  type ActiveWorkspacePointer,
  type StoredWorkspaceLogin,
  type WorkspaceAuth,
  type WorkspaceAuthToken
} from './login.js';
export { canonicalizeCloudUrl } from './cloud-url.js';
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

const INPUT_ENV_PREFIX = 'WORKFORCE_INPUT_';

export async function deploy(
  opts: DeployOptions,
  resolvers: DeployResolvers = {}
): Promise<DeployResult> {
  const inputs = opts.inputs && Object.keys(opts.inputs).length > 0 ? opts.inputs : undefined;
  if (!inputs) return deployInternal(opts, resolvers);

  const preflight = await preflightPersona(opts.personaPath);
  validateDeployInputs(inputs, preflight.persona.inputs);
  return deployInternal(opts, wrapInputResolvers(resolvers, inputs, opts.cloudUrl));
}

function validateDeployInputs(
  inputs: Record<string, string>,
  declared: DeployPreflightPersonaInputs
): void {
  const declaredKeys = Object.keys(declared ?? {});
  for (const [key, value] of Object.entries(inputs)) {
    if (typeof value !== 'string') {
      throw new Error(`Input '${key}' must be a string`);
    }
    if (!Object.prototype.hasOwnProperty.call(declared ?? {}, key)) {
      const list = declaredKeys.length > 0 ? declaredKeys.join(', ') : '(none)';
      throw new Error(`Unknown input '${key}'; persona declares: ${list}`);
    }
  }
}

type DeployPreflightPersonaInputs = NonNullable<
  Awaited<ReturnType<typeof preflightPersona>>['persona']['inputs']
> | undefined;

function wrapInputResolvers(
  resolvers: DeployResolvers,
  inputs: Record<string, string>,
  cloudUrl: string | undefined
): DeployResolvers {
  return {
    ...resolvers,
    modes: {
      dev: wrapLauncher(resolvers.modes?.dev ?? devLauncher, inputs, cloudUrl),
      sandbox: wrapLauncher(resolvers.modes?.sandbox ?? sandboxLauncher, inputs, cloudUrl),
      cloud: wrapLauncher(resolvers.modes?.cloud ?? cloudLauncher, inputs, cloudUrl)
    }
  };
}

function wrapLauncher(
  launcher: ModeLauncher,
  inputs: Record<string, string>,
  cloudUrl: string | undefined
): ModeLauncher {
  return {
    async launch(input: ModeLaunchInput) {
      return launcher.launch({
        ...input,
        env: {
          ...(input.env ?? {}),
          ...toInputEnv(inputs)
        },
        inputs,
        ...(cloudUrl ? { cloudUrl } : {})
      });
    }
  };
}

function toInputEnv(inputs: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(inputs).map(([key, value]) => [`${INPUT_ENV_PREFIX}${key}`, value])
  );
}
