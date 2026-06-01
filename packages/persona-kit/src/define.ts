import type {
  ProactiveCapabilities,
  Harness,
  HarnessSettings,
  IntegrationSource,
  McpServerSpec,
  PersonaInputSpec,
  PersonaMemory,
  PersonaMount,
  PersonaPermissions,
  PersonaSkill,
  SidecarMdMode
} from './types.js';
import type { KnownProviderName, KnownTriggerName } from './triggers.js';
import type { KnownPersonaTag } from './constants.js';

export type TriggerNameFor<P extends string> = P extends KnownProviderName
  ? KnownTriggerName<P> | (string & {})
  : string;

export interface TypedTrigger<P extends string> {
  on: TriggerNameFor<P>;
  match?: string;
  where?: string;
}

/**
 * Provider-keyed map of typed triggers — the authoring shape of an agent's
 * `triggers` (see `defineAgent` in `@agentworkforce/runtime`). Keying by
 * provider gives per-provider event autocomplete (`github` → `pull_request.*`)
 * via {@link TypedTrigger}; arbitrary provider slugs fall back to `string`.
 * Mirrors {@link TypedIntegrations} so agent triggers and persona integration
 * connections line up on the same provider keys.
 */
export type TypedTriggerMap = {
  [P in KnownProviderName]?: readonly TypedTrigger<P>[];
} & {
  [provider: string]: readonly TypedTrigger<string>[] | undefined;
};

/**
 * Per-provider integration **connection** config in typed persona authoring.
 * Connection-only (source + scope) — event triggers live on the agent
 * ({@link TypedTriggerMap}), not here. The `P` param is retained for symmetry
 * with {@link TypedIntegrations} and forward-compatibility.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export interface TypedIntegrationConfig<P extends string = string> {
  source?: IntegrationSource;
  scope?: Record<string, string>;
}

export type TypedIntegrations = {
  [P in KnownProviderName]?: TypedIntegrationConfig<P>;
} & {
  [provider: string]: TypedIntegrationConfig<string> | undefined;
};

export interface PersonaDefinitionBase {
  id: string;
  intent: string;
  /** Catalog labels — must be from the closed {@link KnownPersonaTag}
   *  vocabulary (the cloud rejects unknown tags with `400 invalid_persona`). */
  tags?: readonly KnownPersonaTag[];
  description: string;
  skills?: readonly PersonaSkill[];
  inputs?: Record<string, PersonaInputSpec | string>;
  harnessSettings: HarnessSettings;
  env?: Record<string, string>;
  mcpServers?: Record<string, McpServerSpec>;
  permissions?: PersonaPermissions;
  mount?: PersonaMount;
  claudeMd?: string;
  claudeMdMode?: SidecarMdMode;
  agentsMd?: string;
  agentsMdMode?: SidecarMdMode;
  claudeMdContent?: string;
  agentsMdContent?: string;
  cloud?: boolean;
  useSubscription?: boolean;
  integrations?: TypedIntegrations;
  capabilities?: ProactiveCapabilities;
  memory?: PersonaMemory;
}

type InteractivePersonaDefinition = PersonaDefinitionBase & {
  onEvent?: undefined;
  harness: Harness;
  model: string;
  systemPrompt: string;
};

type HandlerPersonaDefinition = PersonaDefinitionBase & {
  onEvent: string;
  harness?: Harness;
  model?: string;
  systemPrompt?: string;
};

export type PersonaDefinition =
  | InteractivePersonaDefinition
  | HandlerPersonaDefinition;

export function definePersona<const T extends PersonaDefinition>(input: T): T {
  return input;
}
