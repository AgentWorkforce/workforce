import {
  A2aAgentCardSchema,
  type A2aAgentCard,
  type A2aSkill
} from '@relaycast/a2a';

import type { CapabilityValue, PersonaSpec } from './types.js';

const DEFAULT_MODES = ['text/plain', 'application/json'] as const;

/** Deployment-specific values that cannot be inferred from a persona definition. */
export interface DeriveAgentCardOptions {
  /** Deployed agent origin. A2A RPC is expected at `<baseUrl>/a2a/rpc`. */
  baseUrl: string;
  /** Deployment or package version advertised by the agent. */
  version: string;
  documentationUrl?: string;
  inputModes?: readonly string[];
  outputModes?: readonly string[];
}

/**
 * Map a parsed persona to Relaycast's canonical A2A agent-card contract.
 *
 * This module intentionally has no Node dependencies so it remains safe to
 * export from persona-kit's side-effect-free `./spec` entrypoint.
 */
export function deriveAgentCard(
  personaSpec: PersonaSpec,
  options: DeriveAgentCardOptions
): A2aAgentCard {
  const integrationTags = Object.keys(personaSpec.integrations ?? {});
  const skills = mergeSkills(personaSpec, integrationTags);

  const relayName =
    typeof personaSpec.relay === 'object' && personaSpec.relay !== null
      ? personaSpec.relay.agentName
      : undefined;

  return A2aAgentCardSchema.parse({
    name: relayName ?? personaSpec.id,
    description: personaSpec.description,
    url: options.baseUrl,
    version: options.version,
    skills,
    capabilities: {
      streaming: capabilityEnabled(personaSpec.capabilities?.streaming),
      pushNotifications: capabilityEnabled(
        personaSpec.capabilities?.pushNotifications
      )
    },
    default_input_modes: [...(options.inputModes ?? DEFAULT_MODES)],
    default_output_modes: [...(options.outputModes ?? DEFAULT_MODES)],
    provider: {
      organization: 'AgentWorkforce',
      persona_id: personaSpec.id,
      intent: personaSpec.intent,
      tags: [...(personaSpec.tags ?? [])]
    },
    ...(options.documentationUrl !== undefined
      ? { documentation_url: options.documentationUrl }
      : {})
  });
}

function mergeSkills(
  personaSpec: PersonaSpec,
  integrationTags: readonly string[]
): A2aSkill[] {
  const skills = personaSpec.skills.map((skill) => ({
    id: skill.id,
    name: humanize(skill.id),
    description: skill.description,
    tags: unique([skill.source, ...integrationTags])
  }));

  for (const [declaredName, value] of Object.entries(
    personaSpec.capabilities ?? {}
  )) {
    if (!capabilityEnabled(value)) continue;

    const id = declaredName === 'pullRequest' ? 'review' : declaredName;
    const existing = skills.find((skill) => skill.id === id);
    if (existing) {
      existing.tags = unique([...(existing.tags ?? []), ...integrationTags]);
      continue;
    }

    skills.push({
      id,
      name: humanize(id),
      description: `Persona capability: ${humanize(id)}`,
      tags: unique(integrationTags)
    });
  }

  // PersonaSpec allows an empty skills/capabilities merge, while the
  // canonical A2A schema requires at least one skill. The intent is the
  // narrowest truthful fallback and keeps every valid persona derivable.
  if (skills.length === 0) {
    skills.push({
      id: personaSpec.intent,
      name: humanize(personaSpec.intent),
      description: personaSpec.description,
      tags: unique(integrationTags)
    });
  }

  return skills;
}

function capabilityEnabled(value: CapabilityValue | undefined): boolean {
  if (value === true) return true;
  if (value === false || value === undefined) return false;
  return value.enabled !== false;
}

function humanize(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[-_:]+/gu, ' ')
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
