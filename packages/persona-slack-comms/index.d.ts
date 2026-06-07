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

export interface SlackCommsPersona {
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

declare const persona: SlackCommsPersona;

export const slackCommsPersona: SlackCommsPersona;

export default persona;
