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

export interface RepoRouterPersona {
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

declare const persona: RepoRouterPersona;

export const repoRouterPersona: RepoRouterPersona;

export default persona;
