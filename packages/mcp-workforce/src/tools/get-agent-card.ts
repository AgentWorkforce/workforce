import {
  deriveAgentCard,
  isIntent,
  isObject,
  parsePersonaSpec,
  type DeriveAgentCardOptions
} from '@agentworkforce/persona-kit/spec';

export interface GetAgentCardArgs extends DeriveAgentCardOptions {
  persona: unknown;
}

/** Return the same canonical card document as `agentworkforce agent-card --json`. */
export function getAgentCardTool(args: GetAgentCardArgs) {
  if (!isObject(args.persona)) {
    throw new Error('get_agent_card: persona must be an object');
  }
  if (typeof args.persona.intent !== 'string' || !isIntent(args.persona.intent)) {
    throw new Error('get_agent_card: persona.intent must be a valid persona intent');
  }

  const persona = parsePersonaSpec(args.persona, args.persona.intent);
  return deriveAgentCard(persona, {
    baseUrl: args.baseUrl,
    version: args.version,
    ...(args.documentationUrl !== undefined
      ? { documentationUrl: args.documentationUrl }
      : {}),
    ...(args.inputModes ? { inputModes: args.inputModes } : {}),
    ...(args.outputModes ? { outputModes: args.outputModes } : {})
  });
}
