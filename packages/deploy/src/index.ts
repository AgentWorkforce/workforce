import {
  deploy as deployInternal,
  pickMode,
  type CloudAuthRecoveryResolver,
  type DeployResolvers
} from './deploy.js';
import { preflightPersona } from './preflight.js';
import { devLauncher } from './modes/dev.js';
import { sandboxLauncher } from './modes/sandbox.js';
import { cloudLauncher } from './modes/cloud/index.js';
import type {
  DeployOptions,
  DeployResult,
  ModeLaunchInput,
  ModeLauncher
} from './types.js';

export { pickMode, type CloudAuthRecoveryResolver, type DeployResolvers };
export { preflightPersona };
export {
  compileAgentSource,
  isSingleFileAgentSource,
  projectCompiledAgentForPersistence,
  type PersistedAgentProjectionV1
} from './compile-agent.js';
export {
  collectPickerInputs,
  connectIntegrations,
  envIntegrationResolver,
  relayfileCatalogConfigKeyResolver,
  relayfileIntegrationResolver,
  relayfileOptionsResolver,
  type CollectPickerInputsInput,
  type ConnectAllInput,
  type ConnectAllResult,
  type IntegrationAuthRecoveryResolver,
  type IntegrationConnectResolver,
  type IntegrationOptionsResolver,
  type PickerOption,
  type ProviderConfigKeyResolver,
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
export { canonicalizeCloudUrl, resolveCloudUrl, type CloudUrlContext } from './cloud-url.js';
export { formatHttpErrorBody } from './error-format.js';
export { createTerminalIO, createBufferedIO, type BufferedIO } from './io.js';
export { bundleStager } from './bundle.js';
export {
  IntegrationsListError,
  UnknownIntegrationProviderError,
  listIntegrations,
  resolveIntegrationProvider,
  type AuthState,
  type CloudApiClientLike,
  type IntegrationConnection,
  type IntegrationRow,
  type IntegrationsDocument,
  type ListIntegrationsOptions,
  type TriggerSource
} from './integrations-list.js';
export {
  assertReadableFile,
  isPersonaSourcePath,
  loadPersonaSourceFile,
  type PersonaSourceLoadResult
} from './persona-source.js';
export { devLauncher } from './modes/dev.js';
export { sandboxLauncher, resolveSandboxAuth, type SandboxAuth } from './modes/sandbox.js';
export { cloudLauncher } from './modes/cloud/index.js';

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
      // `input.inputs` carries deployInternal's resolved set — the CLI
      // `--input` values plus any picker-collected picks. Merge so those picks
      // survive; the closure `inputs` (CLI only) is authoritative on overlap,
      // but pickers skip already-set keys so overlapping values are identical.
      const mergedInputs = { ...(input.inputs ?? {}), ...inputs };
      return launcher.launch({
        ...input,
        env: {
          ...(input.env ?? {}),
          ...toInputEnv(mergedInputs)
        },
        inputs: mergedInputs,
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
