export interface PersonaSkill {
  id: string;
  source: string;
  description?: string;
}

export interface PersonaInput {
  description: string;
  default?: string;
}

export interface PersonaPermissions {
  mode: string;
}

export interface AutonomousActorPersona {
  id: string;
  intent: string;
  tags: string[];
  description: string;
  skills: PersonaSkill[];
  inputs: Record<string, PersonaInput>;
  mcpServers: Record<string, unknown>;
  permissions: PersonaPermissions;
  claudeMdContent: string;
  harness: string;
  model: string;
  systemPrompt: string;
  harnessSettings: Record<string, unknown>;
}

declare const persona: AutonomousActorPersona;

export const autonomousActorPersona: AutonomousActorPersona;

export default persona;
