import {
  deriveAgentCard,
  type DeriveAgentCardOptions
} from '@agentworkforce/persona-kit';

import {
  DEFAULT_COMPILED_AGENT_CARD_OPTIONS,
  loadParsedPersonaSourceFile,
  parseAgentCardOptions
} from './persona-compile.js';

interface Writable {
  write(chunk: string): unknown;
}

interface AgentCardCommandDeps {
  stdout?: Writable;
}

export async function runAgentCardCommand(
  args: readonly string[],
  deps: AgentCardCommandDeps = {}
): Promise<void> {
  const stdout = deps.stdout ?? process.stdout;
  if (args[0] === '-h' || args[0] === '--help') {
    stdout.write(AGENT_CARD_USAGE);
    return;
  }

  const { personaPath, json, options } = parseAgentCardCommandArgs(args);
  const { persona } = await loadParsedPersonaSourceFile(personaPath);
  const card = deriveAgentCard(persona, options);

  // MCP's JSON text content uses JSON.stringify without whitespace. Keep the
  // CLI --json surface byte-identical so either presenter is interchangeable.
  stdout.write(json ? JSON.stringify(card) : `${JSON.stringify(card, null, 2)}\n`);
}

export function parseAgentCardCommandArgs(args: readonly string[]): {
  personaPath: string;
  json: boolean;
  options: DeriveAgentCardOptions;
} {
  let personaPath: string | undefined;
  let json = false;
  const optionArgs: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      json = true;
    } else if (arg?.startsWith('--')) {
      optionArgs.push(arg);
      if (!arg.includes('=')) {
        const value = args[++index];
        if (value !== undefined) optionArgs.push(value);
      }
    } else if (!personaPath && arg) {
      personaPath = arg;
    } else {
      throw new Error(`agent-card: unexpected argument "${arg}"`);
    }
  }

  if (!personaPath) {
    throw new Error('agent-card: missing <path/to/persona.ts|persona.json>');
  }

  return {
    personaPath,
    json,
    options: {
      ...DEFAULT_COMPILED_AGENT_CARD_OPTIONS,
      ...parseAgentCardOptions(optionArgs, 'agent-card')
    }
  };
}

const AGENT_CARD_USAGE = `Usage: agentworkforce agent-card <path/to/persona.ts|persona.json> [flags]

Derive a schema-validated A2A agent card from a persona.

Flags:
  --base-url <url>          Deployed agent origin (default: http://localhost:3000)
  --version <version>       Deployment/package version (default: 0.0.0)
  --documentation-url <url> Optional persona documentation URL
  --input-mode <mime>       Override an input mode; repeat for multiple modes
  --output-mode <mime>      Override an output mode; repeat for multiple modes
  --json                     Emit compact JSON matching get_agent_card exactly
`;
