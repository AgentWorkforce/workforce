import frontendImplementer from '../../../personas/frontend-implementer.json' with { type: 'json' };
import codeReviewer from '../../../personas/code-reviewer.json' with { type: 'json' };
import architecturePlanner from '../../../personas/architecture-planner.json' with { type: 'json' };
import requirementsAnalyst from '../../../personas/requirements-analyst.json' with { type: 'json' };
import debuggerPersona from '../../../personas/debugger.json' with { type: 'json' };
import securityReviewer from '../../../personas/security-reviewer.json' with { type: 'json' };
import technicalWriter from '../../../personas/technical-writer.json' with { type: 'json' };
import verifierPersona from '../../../personas/verifier.json' with { type: 'json' };
import testStrategist from '../../../personas/test-strategist.json' with { type: 'json' };
import tddGuard from '../../../personas/tdd-guard.json' with { type: 'json' };
import flakeHunter from '../../../personas/flake-hunter.json' with { type: 'json' };
import defaultRoutingProfileJson from '../routing-profiles/default.json' with { type: 'json' };

export const HARNESS_VALUES = ['opencode', 'codex'] as const;
export const PERSONA_TIERS = ['best', 'best-value', 'minimum'] as const;
export const PERSONA_INTENTS = [
  'implement-frontend',
  'review',
  'architecture-plan',
  'requirements-analysis',
  'debugging',
  'security-review',
  'documentation',
  'verification',
  'test-strategy',
  'tdd-enforcement',
  'flake-investigation'
] as const;

export type Harness = (typeof HARNESS_VALUES)[number];
export type PersonaTier = (typeof PERSONA_TIERS)[number];
export type PersonaIntent = (typeof PERSONA_INTENTS)[number];

export interface HarnessSettings {
  reasoning: 'low' | 'medium' | 'high';
  timeoutSeconds: number;
}

export interface PersonaRuntime {
  harness: Harness;
  model: string;
  systemPrompt: string;
  harnessSettings: HarnessSettings;
}

export interface PersonaSpec {
  id: string;
  intent: PersonaIntent;
  description: string;
  tiers: Record<PersonaTier, PersonaRuntime>;
}

export interface RoutingProfileRule {
  tier: PersonaTier;
  rationale: string;
}

export interface RoutingProfile {
  id: string;
  description: string;
  intents: Record<PersonaIntent, RoutingProfileRule>;
}

export interface PersonaSelection {
  personaId: string;
  tier: PersonaTier;
  runtime: PersonaRuntime;
  rationale: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHarness(value: unknown): value is Harness {
  return typeof value === 'string' && HARNESS_VALUES.includes(value as Harness);
}

function isTier(value: unknown): value is PersonaTier {
  return typeof value === 'string' && PERSONA_TIERS.includes(value as PersonaTier);
}

function isIntent(value: unknown): value is PersonaIntent {
  return typeof value === 'string' && PERSONA_INTENTS.includes(value as PersonaIntent);
}

function parseRuntime(value: unknown, context: string): PersonaRuntime {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }

  const { harness, model, systemPrompt, harnessSettings } = value;

  if (!isHarness(harness)) {
    throw new Error(`${context}.harness must be one of: ${HARNESS_VALUES.join(', ')}`);
  }
  if (typeof model !== 'string' || !model.trim()) {
    throw new Error(`${context}.model must be a non-empty string`);
  }
  if (typeof systemPrompt !== 'string' || !systemPrompt.trim()) {
    throw new Error(`${context}.systemPrompt must be a non-empty string`);
  }
  if (!isObject(harnessSettings)) {
    throw new Error(`${context}.harnessSettings must be an object`);
  }

  const { reasoning, timeoutSeconds } = harnessSettings;
  if (!['low', 'medium', 'high'].includes(String(reasoning))) {
    throw new Error(`${context}.harnessSettings.reasoning must be low|medium|high`);
  }
  if (typeof timeoutSeconds !== 'number' || !Number.isFinite(timeoutSeconds) || timeoutSeconds <= 0) {
    throw new Error(`${context}.harnessSettings.timeoutSeconds must be a positive number`);
  }

  return {
    harness,
    model,
    systemPrompt,
    harnessSettings: {
      reasoning: reasoning as HarnessSettings['reasoning'],
      timeoutSeconds
    }
  };
}

function parsePersonaSpec(value: unknown, expectedIntent: PersonaIntent): PersonaSpec {
  if (!isObject(value)) {
    throw new Error(`persona[${expectedIntent}] must be an object`);
  }

  const { id, intent, description, tiers } = value;

  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`persona[${expectedIntent}].id must be a non-empty string`);
  }
  if (!isIntent(intent)) {
    throw new Error(`persona[${expectedIntent}].intent is invalid`);
  }
  if (intent !== expectedIntent) {
    throw new Error(`persona[${expectedIntent}] intent mismatch: got ${intent}`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`persona[${expectedIntent}].description must be a non-empty string`);
  }
  if (!isObject(tiers)) {
    throw new Error(`persona[${expectedIntent}].tiers must be an object`);
  }

  const parsedTiers = {} as Record<PersonaTier, PersonaRuntime>;
  for (const tier of PERSONA_TIERS) {
    parsedTiers[tier] = parseRuntime(tiers[tier], `persona[${expectedIntent}].tiers.${tier}`);
  }

  return {
    id,
    intent,
    description,
    tiers: parsedTiers
  };
}

function parseRoutingProfile(value: unknown, context: string): RoutingProfile {
  if (!isObject(value)) {
    throw new Error(`${context} must be an object`);
  }

  const { id, description, intents } = value;
  if (typeof id !== 'string' || !id.trim()) {
    throw new Error(`${context}.id must be a non-empty string`);
  }
  if (typeof description !== 'string' || !description.trim()) {
    throw new Error(`${context}.description must be a non-empty string`);
  }
  if (!isObject(intents)) {
    throw new Error(`${context}.intents must be an object`);
  }

  const parsedIntents = {} as Record<PersonaIntent, RoutingProfileRule>;
  for (const intent of PERSONA_INTENTS) {
    const rule = intents[intent];
    if (!isObject(rule)) {
      throw new Error(`${context}.intents.${intent} must be an object`);
    }
    const { tier, rationale } = rule;
    if (!isTier(tier)) {
      throw new Error(`${context}.intents.${intent}.tier must be one of: ${PERSONA_TIERS.join(', ')}`);
    }
    if (typeof rationale !== 'string' || !rationale.trim()) {
      throw new Error(`${context}.intents.${intent}.rationale must be a non-empty string`);
    }
    parsedIntents[intent] = { tier, rationale };
  }

  return {
    id,
    description,
    intents: parsedIntents
  };
}

export const personaCatalog: Record<PersonaIntent, PersonaSpec> = {
  'implement-frontend': parsePersonaSpec(frontendImplementer, 'implement-frontend'),
  review: parsePersonaSpec(codeReviewer, 'review'),
  'architecture-plan': parsePersonaSpec(architecturePlanner, 'architecture-plan'),
  'requirements-analysis': parsePersonaSpec(requirementsAnalyst, 'requirements-analysis'),
  debugging: parsePersonaSpec(debuggerPersona, 'debugging'),
  'security-review': parsePersonaSpec(securityReviewer, 'security-review'),
  documentation: parsePersonaSpec(technicalWriter, 'documentation'),
  verification: parsePersonaSpec(verifierPersona, 'verification'),
  'test-strategy': parsePersonaSpec(testStrategist, 'test-strategy'),
  'tdd-enforcement': parsePersonaSpec(tddGuard, 'tdd-enforcement'),
  'flake-investigation': parsePersonaSpec(flakeHunter, 'flake-investigation')
};

export const routingProfiles = {
  default: parseRoutingProfile(defaultRoutingProfileJson, 'routingProfiles.default')
} as const;

export type RoutingProfileId = keyof typeof routingProfiles;

export function resolvePersona(intent: PersonaIntent, profile: RoutingProfile | RoutingProfileId = 'default'): PersonaSelection {
  const profileSpec = typeof profile === 'string' ? routingProfiles[profile] : profile;
  const rule = profileSpec.intents[intent];
  const spec = personaCatalog[intent];

  return {
    personaId: spec.id,
    tier: rule.tier,
    runtime: spec.tiers[rule.tier],
    rationale: `${profileSpec.id}: ${rule.rationale}`
  };
}

/**
 * Backward-compatible helper for callers that already selected a tier directly.
 * Prefer resolvePersona(intent, profile) for policy-driven selection.
 */
export function resolvePersonaByTier(intent: PersonaIntent, tier: PersonaTier = 'best-value'): PersonaSelection {
  const spec = personaCatalog[intent];
  return {
    personaId: spec.id,
    tier,
    runtime: spec.tiers[tier],
    rationale: `legacy-tier-override: ${tier}`
  };
}

export * from './eval.js';
