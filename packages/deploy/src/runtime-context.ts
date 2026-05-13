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

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function resolveAgentContext(
  persona: PersonaSpec,
  env: Record<string, string> | undefined
): RuntimeAgentContext {
  return {
    id: nonEmpty(env?.WORKFORCE_AGENT_ID) ?? persona.id,
    deployedName: nonEmpty(env?.WORKFORCE_AGENT_DEPLOYED_NAME) ?? persona.id,
    spawnedByAgentId: nonEmpty(env?.WORKFORCE_SPAWNED_BY_AGENT_ID) ?? null
  };
}

function resolveDeploymentContext(
  persona: PersonaSpec,
  env: Record<string, string> | undefined
): RuntimeDeploymentContext {
  return {
    id: nonEmpty(env?.WORKFORCE_DEPLOYMENT_ID) ?? persona.id,
    triggerKind: parseTriggerKind(nonEmpty(env?.WORKFORCE_DEPLOYMENT_TRIGGER_KIND)) ?? inferTriggerKind(persona),
    parentDeploymentId: nonEmpty(env?.WORKFORCE_PARENT_DEPLOYMENT_ID) ?? null
  };
}

function parseTriggerKind(value: string | undefined): RuntimeTriggerKind | undefined {
  if (value === 'inbox' || value === 'clock' || value === 'radio') return value;
  return undefined;
}

function inferTriggerKind(persona: PersonaSpec): RuntimeTriggerKind {
  if (hasIntegrationTriggers(persona)) return 'radio';
  return 'clock';
}

function hasIntegrationTriggers(persona: PersonaSpec): boolean {
  return Object.values(persona.integrations ?? {}).some((integration) => (integration.triggers?.length ?? 0) > 0);
}
