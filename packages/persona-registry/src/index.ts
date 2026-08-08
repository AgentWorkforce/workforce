import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';

import {
  resolveSidecar,
  type Harness,
  type PersonaSelection,
  type PersonaSpec
} from '@agentworkforce/persona-kit';
import {
  listBuiltInPersonas,
  personaCatalog,
  routingProfiles
} from '@agentworkforce/workload-router';

export * from './local-personas.js';

import {
  loadLocalPersonas,
  loadPersonaSourceConfig,
  type LoadOptions,
  type PersonaSource
} from './local-personas.js';

export interface ResolvedPersonaReference {
  /** Fully merged spec from the winning registry layer. */
  spec: PersonaSpec;
  /** Interactive runtime projection accepted by persona-kit's spawn planner. */
  selection: PersonaSelection;
  /** Registry source (`cwd`, `personal`, `dir:N`, or `built-in`). */
  source: PersonaSource;
  /** Declaring JSON file for file-backed personas. */
  path?: string;
  /** Non-fatal config/source warnings collected while loading the registry. */
  warnings: string[];
}

export class PersonaResolutionError extends Error {
  readonly code: 'invalid_reference' | 'unknown_persona' | 'not_interactive';

  constructor(code: PersonaResolutionError['code'], message: string) {
    super(message);
    this.name = 'PersonaResolutionError';
    this.code = code;
  }
}

/** Replace the only harness placeholder the CLI resolves before launch. */
export function resolveSystemPromptPlaceholders(prompt: string, harness: Harness): string {
  return prompt.replaceAll('<harness>', harness);
}

/**
 * Resolve a persona id, built-in intent, or JSON path through the canonical
 * registry cascade without starting the AgentWorkforce CLI.
 */
export function resolvePersonaReference(
  reference: string,
  options: LoadOptions = {}
): ResolvedPersonaReference {
  const selector = reference.trim();
  if (!selector) {
    throw new PersonaResolutionError('invalid_reference', 'persona reference must be non-empty');
  }
  if (selector.includes('@') && !looksLikePath(selector)) {
    throw new PersonaResolutionError(
      'invalid_reference',
      '@<tier> selectors were removed; pass the persona id without a tier suffix'
    );
  }

  const cwd = options.cwd ?? process.cwd();
  const candidatePath = isAbsolute(selector) ? selector : resolvePath(cwd, selector);
  const explicitPath = looksLikePath(selector);
  const baseConfig = loadPersonaSourceConfig(options);
  let lookupOptions = options;
  let lookupId = selector;
  let requestedPath: string | undefined;

  if (explicitPath) {
    if (!existsSync(candidatePath)) {
      throw new PersonaResolutionError('invalid_reference', `persona file not found: ${selector}`);
    }
    if (!candidatePath.toLowerCase().endsWith('.json')) {
      throw new PersonaResolutionError(
        'invalid_reference',
        'interactive persona paths must point to a JSON persona file'
      );
    }
    const raw = readJsonPersona(candidatePath);
    if (typeof raw.id !== 'string' || !raw.id.trim()) {
      throw new PersonaResolutionError(
        'invalid_reference',
        `persona file ${selector} is missing a non-empty id`
      );
    }
    lookupId = raw.id.trim();
    requestedPath = candidatePath;
    lookupOptions = {
      ...options,
      cwd,
      // The exact file is a dedicated highest-priority layer. The normal cwd,
      // configured, personal, and built-in layers remain beneath it for
      // inheritance.
      personaPath: candidatePath,
      personaDirs: baseConfig.personaDirs
    };
  }

  const local = loadLocalPersonas(lookupOptions);
  const localSpec = local.byId.get(lookupId);
  if (
    requestedPath &&
    (local.sources.get(lookupId) !== 'path' || local.paths.get(lookupId) !== requestedPath)
  ) {
    const detail = local.warnings.find((warning) => warning.startsWith('[path]'));
    throw new PersonaResolutionError(
      'invalid_reference',
      detail ?? `could not resolve persona file: ${selector}`
    );
  }
  if (localSpec) {
    const source = local.sources.get(lookupId) ?? 'cwd';
    return {
      spec: localSpec,
      selection: buildPersonaSelection(localSpec, 'local'),
      source,
      path: requestedPath ?? local.paths.get(lookupId),
      warnings: [...local.warnings]
    };
  }

  const byIntent = (personaCatalog as Record<string, PersonaSpec | undefined>)[lookupId];
  const builtIn = byIntent ?? listBuiltInPersonas().find((persona) => persona.id === lookupId);
  if (!builtIn) {
    const known = new Set<string>([
      ...local.byId.keys(),
      ...listBuiltInPersonas().map((persona) => persona.id)
    ]);
    throw new PersonaResolutionError(
      'unknown_persona',
      `Unknown persona "${lookupId}". Known personas: ${[...known].sort().join(', ') || '(none)'}`
    );
  }
  return {
    spec: builtIn,
    selection: buildPersonaSelection(builtIn, 'built-in'),
    source: 'built-in',
    warnings: [...local.warnings]
  };
}

function readJsonPersona(path: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('must contain a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new PersonaResolutionError(
      'invalid_reference',
      `could not read persona file: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function looksLikePath(value: string): boolean {
  return value.endsWith('.json') || value.includes('/') || value.includes('\\');
}

function buildPersonaSelection(
  spec: PersonaSpec,
  kind: 'local' | 'built-in'
): PersonaSelection {
  if (!spec.harness || !spec.model || spec.systemPrompt === undefined) {
    const missing = [
      !spec.harness && 'harness',
      !spec.model && 'model',
      spec.systemPrompt === undefined && 'systemPrompt'
    ].filter(Boolean).join(', ');
    throw new PersonaResolutionError(
      'not_interactive',
      `persona "${spec.id}" cannot be spawned interactively because it omits ${missing}`
    );
  }

  const sidecar = resolveSidecar(spec);
  const rationale = kind === 'local'
    ? `local-override: ${spec.id}`
    : (
        routingProfiles.default.intents as Partial<Record<string, { rationale: string }>>
      )[spec.intent]?.rationale ?? `registry: ${spec.id}`;

  return {
    personaId: spec.id,
    harness: spec.harness,
    model: spec.model,
    systemPrompt: resolveSystemPromptPlaceholders(spec.systemPrompt, spec.harness),
    harnessSettings: spec.harnessSettings,
    skills: spec.skills,
    rationale,
    ...(spec.inputs ? { inputs: spec.inputs } : {}),
    ...(spec.env ? { env: spec.env } : {}),
    ...(spec.mcpServers ? { mcpServers: spec.mcpServers } : {}),
    ...(spec.permissions ? { permissions: spec.permissions } : {}),
    ...(spec.mount ? { mount: spec.mount } : {}),
    ...(spec.memory !== undefined ? { memory: spec.memory } : {}),
    ...(sidecar.claudeMd ? { claudeMd: sidecar.claudeMd } : {}),
    ...(sidecar.claudeMdContent ? { claudeMdContent: sidecar.claudeMdContent } : {}),
    ...(sidecar.claudeMd || sidecar.claudeMdContent
      ? { claudeMdMode: sidecar.claudeMdMode }
      : {}),
    ...(sidecar.agentsMd ? { agentsMd: sidecar.agentsMd } : {}),
    ...(sidecar.agentsMdContent ? { agentsMdContent: sidecar.agentsMdContent } : {}),
    ...(sidecar.agentsMd || sidecar.agentsMdContent
      ? { agentsMdMode: sidecar.agentsMdMode }
      : {})
  };
}
