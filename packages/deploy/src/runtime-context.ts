import type { PersonaSpec } from '@agentworkforce/persona-kit';

const AGENT_CONTEXT_ENV = 'WORKFORCE_AGENT_CONTEXT';
const DEPLOYMENT_CONTEXT_ENV = 'WORKFORCE_DEPLOYMENT_CONTEXT';

type RuntimeTriggerKind = 'inbox' | 'clock' | 'radio';

interface RuntimeAgentContext {
  readonly id: string;
  readonly deployedName: string;
  readonly spawnedByAgentId: string | null;
}

interface RuntimeDeploymentContext {
  readonly id: string;
  readonly triggerKind: RuntimeTriggerKind;
  readonly parentDeploymentId: string | null;
}

export function runtimeContextEnv(
  persona: PersonaSpec,
  env: Record<string, string> | undefined
): Record<string, string> {
  return {
    [AGENT_CONTEXT_ENV]: env?.[AGENT_CONTEXT_ENV] ?? JSON.stringify(resolveAgentContext(persona, env)),
    [DEPLOYMENT_CONTEXT_ENV]:
      env?.[DEPLOYMENT_CONTEXT_ENV] ?? JSON.stringify(resolveDeploymentContext(persona, env))
  };
}

function resolveAgentContext(
  persona: PersonaSpec,
  env: Record<string, string> | undefined
): RuntimeAgentContext {
  return {
    id: env?.WORKFORCE_AGENT_ID ?? persona.id,
    deployedName: env?.WORKFORCE_AGENT_DEPLOYED_NAME ?? persona.id,
    spawnedByAgentId: env?.WORKFORCE_SPAWNED_BY_AGENT_ID ?? null
  };
}

function resolveDeploymentContext(
  persona: PersonaSpec,
  env: Record<string, string> | undefined
): RuntimeDeploymentContext {
  return {
    id: env?.WORKFORCE_DEPLOYMENT_ID ?? persona.id,
    triggerKind: parseTriggerKind(env?.WORKFORCE_DEPLOYMENT_TRIGGER_KIND) ?? inferTriggerKind(persona),
    parentDeploymentId: env?.WORKFORCE_PARENT_DEPLOYMENT_ID ?? null
  };
}

function parseTriggerKind(value: string | undefined): RuntimeTriggerKind | undefined {
  if (value === 'inbox' || value === 'clock' || value === 'radio') return value;
  return undefined;
}

function inferTriggerKind(persona: PersonaSpec): RuntimeTriggerKind {
  if (persona.integrations && Object.keys(persona.integrations).length > 0) return 'inbox';
  return 'clock';
}
