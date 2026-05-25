import { builtinModules } from 'node:module';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isIntent, isObject, parsePersonaSpec } from '@agentworkforce/persona-kit';
import { build } from 'esbuild';

export interface PersonaCompileResult {
  inputPath: string;
  outputPath: string;
  personaId: string;
}

const NODE_EXTERNALS = [
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'node:*'
];

export async function compilePersonaFile(
  inputPath: string,
  outputPath?: string
): Promise<PersonaCompileResult> {
  const absInput = resolve(inputPath);
  await assertReadableFile(absInput, 'persona compile input');

  const absOutput = resolve(outputPath ?? join(dirname(absInput), 'persona.json'));
  const tempDir = await mkdtemp(join(tmpdir(), 'agentworkforce-persona-compile-'));
  const bundledPath = join(tempDir, `${basename(absInput).replace(/\W+/g, '-')}.mjs`);

  try {
    await build({
      entryPoints: [absInput],
      outfile: bundledPath,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node20',
      sourcemap: 'inline',
      logLevel: 'silent',
      external: NODE_EXTERNALS,
      resolveExtensions: ['.ts', '.mts', '.cts', '.tsx', '.js', '.mjs', '.cjs', '.jsx', '.json'],
      nodePaths: packageNodePaths()
    });

    const mod = await import(pathToFileURL(bundledPath).href);
    const spec = mod.default as unknown;
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
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
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

async function assertReadableFile(abs: string, label: string): Promise<void> {
  try {
    const st = await stat(abs);
    if (!st.isFile()) {
      throw new Error(`${label}: ${abs} is not a regular file`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`${label}: file not found at ${abs}`);
    }
    throw err;
  }
}

function packageNodePaths(): string[] {
  const here = dirname(fileURLToPath(import.meta.url));
  return [
    join(here, '..', 'node_modules'),
    join(here, '..', '..', 'node_modules'),
    join(process.cwd(), 'node_modules')
  ];
}
