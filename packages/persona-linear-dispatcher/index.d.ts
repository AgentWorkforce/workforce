export interface PersonaSkill {
  id: string;
  source: string;
  description?: string;
}

export interface PersonaInput {
  description: string;
  default?: string;
  optional?: boolean;
}

export interface LinearDispatcherPersona {
  id: string;
  intent: string;
  tags: string[];
  description: string;
  integrations: Record<string, unknown>;
  skills: PersonaSkill[];
  harness: string;
  model: string;
  systemPrompt: string;
  harnessSettings: Record<string, unknown>;
  inputs: Record<string, PersonaInput>;
  agentsMd: string;
}

declare const persona: LinearDispatcherPersona;

export const linearDispatcherPersona: LinearDispatcherPersona;

export default persona;
