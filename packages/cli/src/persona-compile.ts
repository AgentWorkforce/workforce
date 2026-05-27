import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { isIntent, isObject, parsePersonaSpec } from '@agentworkforce/persona-kit';
import { loadPersonaSourceFile } from '@agentworkforce/deploy';

export interface PersonaCompileResult {
  inputPath: string;
  outputPath: string;
  personaId: string;
}

export async function compilePersonaFile(
  inputPath: string,
  outputPath?: string
): Promise<PersonaCompileResult> {
  const absInput = resolve(inputPath);
  const absOutput = resolve(outputPath ?? join(dirname(absInput), 'persona.json'));

  const { persona: spec } = await loadPersonaSourceFile(absInput);
  if (!isObject(spec)) {
    throw new Error('persona compile: default export must be a persona object');
  }
  if (typeof spec.intent !== 'string') {
    throw new Error('persona compile: default export must include a string intent');
  }
  if (!isIntent(spec.intent)) {
    throw new Error(`persona compile: intent "${spec.intent}" is invalid`);
  }
  const parsed = parsePersonaSpec(spec, spec.intent);

  await mkdir(dirname(absOutput), { recursive: true });
  await writeFile(absOutput, JSON.stringify(spec, null, 2) + '\n', 'utf8');

  return {
    inputPath: absInput,
    outputPath: absOutput,
    personaId: parsed.id
  };
}

export async function runPersonaCompileCommand(args: string[]): Promise<void> {
  const [action, personaPath, ...rest] = args;
  if (!action || action === '-h' || action === '--help') {
    process.stdout.write('Usage: agentworkforce persona compile <path/to/persona.ts>\n');
    process.exit(action ? 0 : 1);
  }
  if (action !== 'compile') {
    throw new Error(`persona: unknown action "${action}". Expected: compile`);
  }
  if (!personaPath) {
    throw new Error('persona compile: missing <path/to/persona.ts>');
  }
  if (rest.length > 0) {
    throw new Error(`persona compile: unexpected argument "${rest[0]}"`);
  }

  const result = await compilePersonaFile(personaPath);
  process.stdout.write(
    `Compiled ${result.inputPath} -> ${result.outputPath} (${result.personaId})\n`
  );
}
