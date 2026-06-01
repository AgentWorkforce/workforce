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
import type { KnownScopeKey, KnownScopeProviderName } from './scopes.js';
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
 * Per-provider scope keys for typed persona authoring. Resolves to the
 * provider's catalogued scope keys (e.g. `github` → `'owner' | 'repo'`) for
 * known providers; `never` for unknown ones (the index signature on
 * {@link TypedScopeMap} still allows arbitrary keys there).
 */
export type ScopeKeysFor<P extends string> = P extends KnownScopeProviderName
  ? KnownScopeKey<P>
  : never;

/**
 * Typed shape of `integrations.<provider>.scope`. Catalogued keys autocomplete
 * and are typed; arbitrary string keys remain allowed (forward-compat — the
 * cloud adapter is the runtime source of truth, and new scope keys shouldn't
 * require a persona-kit release).
 */
export type TypedScopeMap<P extends string> = {
  [K in ScopeKeysFor<P>]?: string;
} & {
  [key: string]: string;
};

/**
 * Per-provider integration **connection** config in typed persona authoring.
 * Connection-only (source + scope) — event triggers live on the agent
 * ({@link TypedTriggerMap}), not here. `scope` keys are typed per provider via
 * {@link TypedScopeMap}.
 */
export interface TypedIntegrationConfig<P extends string = string> {
  source?: IntegrationSource;
  scope?: TypedScopeMap<P>;
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
