import frontendImplementer from '../../../personas/frontend-implementer.json' assert { type: 'json' };
import codeReviewer from '../../../personas/code-reviewer.json' assert { type: 'json' };
import architecturePlanner from '../../../personas/architecture-planner.json' assert { type: 'json' };

export type Harness = 'opencode' | 'codex';
export type PersonaTier = 'best' | 'best-value' | 'minimum';
export type PersonaIntent = 'implement-frontend' | 'review' | 'architecture-plan';

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

export interface PersonaSelection {
  personaId: string;
  intent: PersonaIntent;
  tier: PersonaTier;
  runtime: PersonaRuntime;
}

export const personaCatalog: Record<PersonaIntent, PersonaSpec> = {
  'implement-frontend': frontendImplementer as PersonaSpec,
  review: codeReviewer as PersonaSpec,
  'architecture-plan': architecturePlanner as PersonaSpec
};

export function resolvePersona(intent: PersonaIntent, tier: PersonaTier = 'best-value'): PersonaSelection {
  const spec = personaCatalog[intent];
  const runtime = spec.tiers[tier];
  return {
    personaId: spec.id,
    intent,
    tier,
    runtime
  };
}
