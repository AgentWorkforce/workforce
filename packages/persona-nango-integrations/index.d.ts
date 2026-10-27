export interface PersonaSkill {
  id: string;
  source: string;
  description?: string;
}

export interface PersonaMcpServer {
  type: string;
  url: string;
}

export interface NangoIntegrationsPersona {
  id: string;
  intent: string;
  tags: string[];
  description: string;
  skills: PersonaSkill[];
  mcpServers: Record<string, PersonaMcpServer>;
  agentsMdContent: string;
  harness: string;
  model: string;
  systemPrompt: string;
  harnessSettings: Record<string, unknown>;
}

declare const persona: NangoIntegrationsPersona;

export const nangoIntegrationsPersona: NangoIntegrationsPersona;

export default persona;
