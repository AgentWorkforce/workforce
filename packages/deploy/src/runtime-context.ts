import type { AgentSpec, PersonaSpec } from '@agentworkforce/persona-kit';

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
  env: Record<string, string> | undefined,
  agent?: AgentSpec
): Record<string, string> {
  return {
    [AGENT_CONTEXT_ENV]:
      nonEmpty(env?.[AGENT_CONTEXT_ENV]) ?? JSON.stringify(resolveAgentContext(persona, env)),
    [DEPLOYMENT_CONTEXT_ENV]:
      nonEmpty(env?.[DEPLOYMENT_CONTEXT_ENV]) ?? JSON.stringify(resolveDeploymentContext(persona, env, agent))
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
  env: Record<string, string> | undefined,
  agent?: AgentSpec
): RuntimeDeploymentContext {
  return {
    id: nonEmpty(env?.WORKFORCE_DEPLOYMENT_ID) ?? persona.id,
    triggerKind: parseTriggerKind(nonEmpty(env?.WORKFORCE_DEPLOYMENT_TRIGGER_KIND)) ?? inferTriggerKind(agent),
    parentDeploymentId: nonEmpty(env?.WORKFORCE_PARENT_DEPLOYMENT_ID) ?? null
  };
}

function parseTriggerKind(value: string | undefined): RuntimeTriggerKind | undefined {
  if (value === 'inbox' || value === 'clock' || value === 'radio') return value;
  return undefined;
}

function inferTriggerKind(agent: AgentSpec | undefined): RuntimeTriggerKind {
  if (hasIntegrationTriggers(agent)) return 'radio';
  return 'clock';
}

function hasIntegrationTriggers(agent: AgentSpec | undefined): boolean {
  return Object.values(agent?.triggers ?? {}).some((triggers) => (triggers?.length ?? 0) > 0);
}
