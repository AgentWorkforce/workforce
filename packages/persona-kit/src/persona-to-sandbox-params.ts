import type { PersonaPermissions, PersonaSpec } from './types.js';

export interface PersonaSandboxParams {
  cli: string;
  relayfilePaths: string[];
  readonlyPaths: string[];
  env: Record<string, string>;
  permissions?: PersonaPermissions;
  label: string;
}

export class PersonaNotSandboxableError extends Error {
  constructor(
    readonly reason: 'no-harness' | 'sandbox-disabled' | 'unsupported-harness',
    personaId: string,
  ) {
    const explanation = {
      'no-harness': 'no harness is configured',
      'sandbox-disabled': 'sandbox is disabled',
      'unsupported-harness': 'the harness is not supported in a sandbox',
    }[reason];
    super(`Persona "${personaId}" cannot run in an interactive sandbox: ${explanation}.`);
    this.name = 'PersonaNotSandboxableError';
  }
}

/** Convert the explicit gitignore subtree allow-list idiom into Cloud paths. */
function mountPaths(persona: PersonaSpec): string[] {
  const mount = persona.mount;
  if (!mount || mount.enabled === false) return [];
  const patterns = mount.ignoredPatterns ?? [];
  if (patterns[0] !== '/*' || patterns.slice(1).some(p => !p.startsWith('!'))) return [];
  const paths = new Set<string>();
  for (const pattern of patterns.slice(1)) {
    const value = pattern.slice(1).replace(/^\//, '');
    if (!value.endsWith('/**')) continue;
    const subtree = value.slice(0, -3);
    if (!subtree || /[*?\[\]{}!]/.test(subtree) || subtree.split('/').some(p => !p || p === '.' || p === '..')) return [];
    // Gitignore needs each excluded parent directory reopened before its contents.
    const parts = subtree.split('/');
    if (!parts.every((_, i) => {
      const parent = parts.slice(0, i + 1).join('/');
      return patterns.includes(`!${parent}`) || patterns.includes(`!/${parent}`) || patterns.includes(`!${parent}/`) || patterns.includes(`!/${parent}/`);
    })) return [];
    paths.add(`/${subtree}/**`);
  }
  return [...paths].sort();
}

export function personaToSandboxParams(
  persona: PersonaSpec,
  ctx: { workspace: string; inputs?: Record<string, string> },
): PersonaSandboxParams {
  if (!persona.harness) throw new PersonaNotSandboxableError('no-harness', persona.id);
  if (persona.sandbox === false) throw new PersonaNotSandboxableError('sandbox-disabled', persona.id);
  if (!['claude', 'codex', 'gemini', 'grok', 'opencode'].includes(persona.harness)) {
    throw new PersonaNotSandboxableError('unsupported-harness', persona.id);
  }
  return {
    cli: persona.harness,
    relayfilePaths: mountPaths(persona),
    readonlyPaths: [...(persona.mount?.readonlyPatterns ?? [])],
    ...personaToSandboxContext(persona, ctx),
    ...(persona.permissions ? { permissions: persona.permissions } : {}),
  };
}

/** @internal Shared identity/env for Node handler deployments, which need no CLI. */
export function personaToSandboxContext(
  persona: PersonaSpec,
  ctx: { workspace: string; inputs?: Record<string, string> },
): Pick<PersonaSandboxParams, 'env' | 'label'> {
  const env: Record<string, string> = { ...persona.env };
  for (const key of Object.keys(persona.integrations ?? {}).sort()) {
    const integrationEnv = persona.integrations?.[key]?.env;
    if (integrationEnv && typeof integrationEnv === 'object' && !Array.isArray(integrationEnv)) {
      for (const [name, value] of Object.entries(integrationEnv)) {
        if (typeof value === 'string') env[name] = value;
      }
    }
  }
  for (const [key, value] of Object.entries(ctx.inputs ?? {})) env[`WORKFORCE_INPUT_${key}`] = value;
  env.WORKFORCE_WORKSPACE_ID = ctx.workspace;
  env.WORKFORCE_PERSONA_ID = persona.id;
  return {
    env: Object.fromEntries(Object.keys(env).sort().map(key => [key, env[key]])),
    label: `wf-${persona.id}`,
  };
}
