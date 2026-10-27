import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  deriveAgentCard,
  isIntent,
  isObject,
  parsePersonaSpec,
  type DeriveAgentCardOptions,
  type PersonaSpec
} from '@agentworkforce/persona-kit';
import { loadPersonaSourceFile } from '@agentworkforce/deploy';

export const DEFAULT_COMPILED_AGENT_CARD_OPTIONS: DeriveAgentCardOptions = {
  baseUrl: 'http://localhost:3000',
  version: '0.0.0'
};

export interface PersonaCompileResult {
  inputPath: string;
  outputPath: string;
  agentCardPath: string;
  personaId: string;
}

export interface LoadedPersonaSource {
  inputPath: string;
  source: Record<string, unknown>;
  persona: PersonaSpec;
}

export async function loadParsedPersonaSourceFile(
  inputPath: string
): Promise<LoadedPersonaSource> {
  const absInput = resolve(inputPath);
  const { persona: source } = await loadPersonaSourceFile(absInput);
  if (!isObject(source)) {
    throw new Error('persona: default export must be a persona object');
  }
  if (typeof source.intent !== 'string') {
    throw new Error('persona: default export must include a string intent');
  }
  if (!isIntent(source.intent)) {
    throw new Error(`persona: intent "${source.intent}" is invalid`);
  }
  return {
    inputPath: absInput,
    source,
    persona: parsePersonaSpec(source, source.intent)
  };
}

export async function compilePersonaFile(
  inputPath: string,
  outputPath?: string,
  agentCardOptions: DeriveAgentCardOptions = DEFAULT_COMPILED_AGENT_CARD_OPTIONS
): Promise<PersonaCompileResult> {
  const loaded = await loadParsedPersonaSourceFile(inputPath);
  const absOutput = resolve(
    outputPath ?? join(dirname(loaded.inputPath), 'persona.json')
  );
  const agentCardPath = join(dirname(absOutput), 'agent-card.json');
  const agentCard = deriveAgentCard(loaded.persona, agentCardOptions);

  await mkdir(dirname(absOutput), { recursive: true });
  await Promise.all([
    writeFile(
      absOutput,
      `${JSON.stringify(loaded.source, null, 2)}\n`,
      'utf8'
    ),
    writeFile(agentCardPath, `${JSON.stringify(agentCard, null, 2)}\n`, 'utf8')
  ]);

  return {
    inputPath: loaded.inputPath,
    outputPath: absOutput,
    agentCardPath,
    personaId: loaded.persona.id
  };
}

export async function runPersonaCompileCommand(args: string[]): Promise<void> {
  const [action, personaPath, ...rest] = args;
  if (!action || action === '-h' || action === '--help') {
    process.stdout.write(
      'Usage: agentworkforce persona compile <path/to/persona.ts> [--base-url <url>] [--version <version>]\n'
    );
    process.exit(action ? 0 : 1);
  }
  if (action !== 'compile') {
    throw new Error(`persona: unknown action "${action}". Expected: compile`);
  }
  if (!personaPath) {
    throw new Error('persona compile: missing <path/to/persona.ts>');
  }
  const agentCardOptions = parseAgentCardOptions(rest, 'persona compile');

  const result = await compilePersonaFile(personaPath, undefined, {
    ...DEFAULT_COMPILED_AGENT_CARD_OPTIONS,
    ...agentCardOptions
  });
  process.stdout.write(
    `Compiled ${result.inputPath} -> ${result.outputPath}, ${result.agentCardPath} (${result.personaId})\n`
  );
}

export function parseAgentCardOptions(
  args: readonly string[],
  context: string
): Partial<DeriveAgentCardOptions> {
  const options: Partial<DeriveAgentCardOptions> = {};
  const inputModes: string[] = [];
  const outputModes: string[] = [];

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--base-url') {
      options.baseUrl = expectValue(context, arg, args[++index]);
    } else if (arg?.startsWith('--base-url=')) {
      options.baseUrl = expectValue(
        context,
        '--base-url',
        arg.slice('--base-url='.length)
      );
    } else if (arg === '--version') {
      options.version = expectValue(context, arg, args[++index]);
    } else if (arg?.startsWith('--version=')) {
      options.version = expectValue(
        context,
        '--version',
        arg.slice('--version='.length)
      );
    } else if (arg === '--documentation-url') {
      options.documentationUrl = expectValue(context, arg, args[++index]);
    } else if (arg?.startsWith('--documentation-url=')) {
      options.documentationUrl = expectValue(
        context,
        '--documentation-url',
        arg.slice('--documentation-url='.length)
      );
    } else if (arg === '--input-mode') {
      inputModes.push(expectValue(context, arg, args[++index]));
    } else if (arg?.startsWith('--input-mode=')) {
      inputModes.push(
        expectValue(context, '--input-mode', arg.slice('--input-mode='.length))
      );
    } else if (arg === '--output-mode') {
      outputModes.push(expectValue(context, arg, args[++index]));
    } else if (arg?.startsWith('--output-mode=')) {
      outputModes.push(
        expectValue(context, '--output-mode', arg.slice('--output-mode='.length))
      );
    } else {
      throw new Error(`${context}: unexpected argument "${arg}"`);
    }
  }

  if (inputModes.length > 0) options.inputModes = inputModes;
  if (outputModes.length > 0) options.outputModes = outputModes;
  return options;
}

function expectValue(
  context: string,
  flag: string,
  value: string | undefined
): string {
  if (!value || value.startsWith('-')) {
    throw new Error(`${context}: ${flag} requires a value`);
  }
  return value;
}
