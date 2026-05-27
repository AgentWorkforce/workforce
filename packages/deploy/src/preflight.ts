import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import {
  lintTriggers,
  parsePersonaSpec,
  type PersonaIntent,
  type PersonaSpec
} from '@agentworkforce/persona-kit';
import {
  isPersonaSourcePath,
  loadPersonaSourceFile
} from './persona-source.js';
import type { DeployPreflight } from './types.js';

/**
 * Load + parse + validate a persona for the deploy surface. Returns the
 * frozen-shape preflight on success, throws with a field-pointed error
 * on validation failure.
 *
 * Deploy preflight is stricter than the persona-kit parser: the parser
 * accepts any persona, valid or not for deploy; this function enforces
 * the deploy-specific cross-field rules (cloud:true, onEvent present when
 * triggers exist, onEvent file actually on disk, etc.) so the orchestrator
 * never gets a half-valid spec.
 */
export async function preflightPersona(personaPath: string): Promise<DeployPreflight> {
  const absPath = path.resolve(personaPath);
  const personaDir = path.dirname(absPath);

  const json = isPersonaSourcePath(absPath)
    ? await readPersonaSource(absPath)
    : await readPersonaJson(absPath);

  if (typeof json !== 'object' || json === null) {
    throw new Error(`persona at ${absPath} must be a top-level object`);
  }

  // The persona-kit parser is intent-aware; we pass the intent it declares
  // back to itself so the check is self-consistent (parsePersonaSpec
  // enforces that `intent` matches `expectedIntent` to catch type-collated
  // mistakes in built-in catalogs). For loose deploy use, mirror the
  // declared intent.
  const declaredIntent = (json as { intent?: unknown }).intent;
  if (typeof declaredIntent !== 'string' || !declaredIntent) {
    throw new Error(`persona at ${absPath} is missing top-level "intent"`);
  }

  const persona: PersonaSpec = parsePersonaSpec(json, declaredIntent as PersonaIntent);

  if (persona.cloud !== true) {
    throw new Error(
      `persona "${persona.id}" is not opted into deploy (set "cloud": true to enable workforce deploy)`
    );
  }

  const hasIntegrationTriggers = !!persona.integrations &&
    Object.values(persona.integrations).some((cfg) => (cfg.triggers?.length ?? 0) > 0);
  const hasSchedules = (persona.schedules?.length ?? 0) > 0;

  if (!hasIntegrationTriggers && !hasSchedules) {
    throw new Error(
      `persona "${persona.id}" declares cloud:true but has no triggers (add at least one schedule or integration trigger)`
    );
  }

  if (!persona.onEvent) {
    throw new Error(
      `persona "${persona.id}" declares cloud:true but is missing "onEvent" (path to the handler file)`
    );
  }

  const onEventPath = path.resolve(personaDir, persona.onEvent);
  const onEventStat = await stat(onEventPath).catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      throw new Error(
        `persona "${persona.id}" onEvent file not found at ${onEventPath} (relative to ${personaDir})`
      );
    }
    throw err;
  });
  if (!onEventStat.isFile()) {
    throw new Error(`onEvent path ${onEventPath} is not a regular file`);
  }

  const triggerLint = lintTriggers(persona);
  const warnings = triggerLint.map(
    (issue) => `${issue.path}: ${issue.message}`
  );

  return {
    persona,
    personaPath: absPath,
    personaDir,
    onEventPath,
    schedules: (persona.schedules ?? []).map((s) => s.name),
    integrations: persona.integrations ? Object.keys(persona.integrations) : [],
    warnings
  };
}

async function readPersonaJson(absPath: string): Promise<unknown> {
  const raw = await readFile(absPath, 'utf8').catch((err: NodeJS.ErrnoException) => {
    if (err.code === 'ENOENT') {
      throw new Error(`persona JSON not found at ${absPath}`);
    }
    throw err;
  });

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `persona JSON at ${absPath} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  return json;
}

async function readPersonaSource(absPath: string): Promise<unknown> {
  const { persona } = await loadPersonaSourceFile(absPath);
  return persona;
}
