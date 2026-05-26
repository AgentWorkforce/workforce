import type {
  Harness,
  HarnessSettings,
  IntegrationSource,
  McpServerSpec,
  PersonaInputSpec,
  PersonaMemory,
  PersonaMount,
  PersonaPermissions,
  PersonaSchedule,
  PersonaSkill,
  SidecarMdMode,
  WatchRule
} from './types.js';
import type { KnownProviderName, KnownTriggerName } from './triggers.js';
import type { PersonaTag } from './constants.js';

export type TriggerNameFor<P extends string> = P extends KnownProviderName
  ? KnownTriggerName<P> | (string & {})
  : string;

export interface TypedTrigger<P extends string> {
  on: TriggerNameFor<P>;
  match?: string;
  where?: string;
}

export interface TypedIntegrationConfig<P extends string> {
  source?: IntegrationSource;
  scope?: Record<string, string>;
  triggers?: readonly TypedTrigger<P>[];
}

export type TypedIntegrations = {
  [P in KnownProviderName]?: TypedIntegrationConfig<P>;
} & {
  [provider: string]: TypedIntegrationConfig<string> | undefined;
};

export interface PersonaDefinitionBase {
  id: string;
  intent: string;
  /** Catalog labels — must be from the closed {@link PersonaTag} vocabulary
   *  (the cloud rejects unknown tags with `400 invalid_persona`). */
  tags?: readonly PersonaTag[];
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
  schedules?: readonly PersonaSchedule[];
  watch?: readonly WatchRule[];
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
