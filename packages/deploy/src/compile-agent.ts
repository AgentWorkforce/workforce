import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  lintTriggers,
  parseAgentSpec,
  parsePersonaSpec,
  type AgentSpec,
  type PersonaIntent,
  type PersonaSpec
} from '@agentworkforce/persona-kit';
import type { CompiledAgentV1, Diagnostic } from '@agentworkforce/runtime';
import { extractAgentSpec } from './extract-agent.js';
import { isPersonaSourcePath, loadPersonaSourceFile } from './persona-source.js';

export interface PersistedAgentProjectionV1 {
  schemaVersion: 1;
  persona: PersonaSpec;
  agent: AgentSpec;
  extensions?: Record<string, unknown>;
}

/** Compile either a single-file Agent preset or the established split form. */
export async function compileAgentSource(inputPath: string): Promise<CompiledAgentV1> {
  const sourcePath = path.resolve(inputPath);
  const raw = isPersonaSourcePath(sourcePath)
    ? (await loadPersonaSourceFile(sourcePath)).persona
    : await readJson(sourcePath);
  if (!isRecord(raw)) throw new Error(`Agent source at ${sourcePath} must default-export an object`);

  if (isSingleFileAgentSource(raw)) return compileSingleFile(sourcePath, raw);
  return compileSplitSource(sourcePath, raw);
}

export function isSingleFileAgentSource(value: unknown): value is Record<string, unknown> & { handler: Function } {
  return isRecord(value)
    && typeof value.handler === 'function'
    && typeof value.id === 'string'
    && typeof value.intent === 'string'
    && typeof value.description === 'string';
}

/** JSON serialization seam used by deploy upload/persistence contract tests. */
export function projectCompiledAgentForPersistence(
  compiled: CompiledAgentV1
): PersistedAgentProjectionV1 {
  return JSON.parse(JSON.stringify({
    schemaVersion: 1,
    persona: compiled.persona,
    agent: compiled.agent,
    ...(compiled.extensions ? { extensions: compiled.extensions } : {})
  })) as PersistedAgentProjectionV1;
}

async function compileSingleFile(
  sourcePath: string,
  source: Record<string, unknown>
): Promise<CompiledAgentV1> {
  const personaInput = { ...source };
  delete personaInput.handler;
  delete personaInput.launchedBy;
  delete personaInput.triggers;
  delete personaInput.schedules;
  delete personaInput.watch;
  delete personaInput.__workforceAgent;
  personaInput.onEvent = `./${path.basename(sourcePath)}`;

  const persona = parsePersona(personaInput, sourcePath);
  const agent = parseAgentSpec({
    ...(source.launchedBy !== undefined ? { launchedBy: source.launchedBy } : {}),
    ...(source.triggers !== undefined ? { triggers: source.triggers } : {}),
    ...(source.schedules !== undefined ? { schedules: source.schedules } : {}),
    ...(source.watch !== undefined ? { watch: source.watch } : {})
  }, `agent "${sourcePath}"`);

  return compiled('single-file', sourcePath, sourcePath, persona, agent, [await readFile(sourcePath)]);
}

async function compileSplitSource(
  sourcePath: string,
  source: Record<string, unknown>
): Promise<CompiledAgentV1> {
  const persona = parsePersona(source, sourcePath);
  if (!persona.onEvent) {
    throw new Error(`persona "${persona.id}" declares no onEvent handler; use defineAgent({...}) for a single-file Agent`);
  }
  const handlerEntry = path.resolve(path.dirname(sourcePath), persona.onEvent);
  const handlerStat = await stat(handlerEntry).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`persona "${persona.id}" onEvent file not found at ${handlerEntry}`);
    throw error;
  });
  if (!handlerStat.isFile()) throw new Error(`onEvent path ${handlerEntry} is not a regular file`);
  const { agent } = await extractAgentSpec(handlerEntry);
  return compiled('split', sourcePath, handlerEntry, persona, agent, [await readFile(sourcePath), await readFile(handlerEntry)]);
}

function compiled(
  sourceKind: CompiledAgentV1['sourceKind'],
  sourcePath: string,
  handlerEntry: string,
  persona: PersonaSpec,
  agent: AgentSpec,
  digestParts: readonly Uint8Array[]
): CompiledAgentV1 {
  const hash = createHash('sha256');
  for (const part of digestParts) hash.update(part);
  const compileWarnings: Diagnostic[] = lintTriggers(agent).map((issue) => ({
    severity: 'warning',
    code: issue.code,
    message: issue.message,
    path: issue.path
  }));
  return {
    schemaVersion: 1,
    sourceKind,
    sourcePath,
    persona,
    agent,
    handlerEntry,
    sourceDigest: `sha256:${hash.digest('hex')}`,
    compileWarnings
  };
}

function parsePersona(value: Record<string, unknown>, sourcePath: string): PersonaSpec {
  if (typeof value.intent !== 'string' || value.intent.length === 0) {
    throw new Error(`persona at ${sourcePath} is missing top-level "intent"`);
  }
  return parsePersonaSpec(value, value.intent as PersonaIntent);
}

async function readJson(sourcePath: string): Promise<unknown> {
  const raw = await readFile(sourcePath, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') throw new Error(`persona JSON not found at ${sourcePath}`);
    throw error;
  });
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`persona JSON at ${sourcePath} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
