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

export interface SlackRelayfileDoctorPersona {
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
  claudeMd: string;
  memory?: Record<string, unknown>;
}

declare const persona: SlackRelayfileDoctorPersona;

export const slackRelayfileDoctorPersona: SlackRelayfileDoctorPersona;

export default persona;
