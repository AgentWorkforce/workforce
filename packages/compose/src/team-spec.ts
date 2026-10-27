import { readFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import type { PersonaRef, TeamMember, TeamSpec } from './types.js';

export const TEAM_SPEC_FILENAME = 'team.json';
const POSTGRES_INTEGER_MAX = 2_147_483_647;

export class TeamSpecError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TeamSpecError';
  }
}

/** Throwing parser compatible with Cloud's original TeamSpec contract. */
export function loadTeamSpec(value: unknown): TeamSpec {
  if (!isRecord(value)) throw new TeamSpecError('TeamSpec must be an object');
  assertKnownKeys(value, new Set(['id', 'lead', 'members', 'delegation', 'tokenBudget', 'timeBudgetSeconds']), 'TeamSpec');
  const id = requireNonEmptyString(value.id, 'id');
  const lead = requireNonEmptyString(value.lead, 'lead');
  if (!Array.isArray(value.members) || value.members.length === 0) {
    throw new TeamSpecError('members must be a non-empty array');
  }

  const members: TeamMember[] = [];
  for (let index = 0; index < value.members.length; index += 1) {
    members.push(parseMember(value.members[index], index));
  }
  const names = new Set<string>();
  const ownedSelectors = new Map<string, string>();
  for (const member of members) {
    if (names.has(member.name)) throw new TeamSpecError(`duplicate member name "${member.name}"`);
    names.add(member.name);
    for (const selector of member.owns ?? []) {
      const key = stableJson(selector);
      const existingOwner = ownedSelectors.get(key);
      if (existingOwner && existingOwner !== member.name) {
        throw new TeamSpecError(`owns selector ${key} is claimed by both "${existingOwner}" and "${member.name}"`);
      }
      ownedSelectors.set(key, member.name);
    }
  }

  const spec: TeamSpec = { id, lead, members };
  const delegation = parseRecordArray(value.delegation, 'delegation');
  const tokenBudget = optionalPositiveInteger(value.tokenBudget, 'tokenBudget');
  const timeBudgetSeconds = optionalPositiveInteger(value.timeBudgetSeconds, 'timeBudgetSeconds');
  if (delegation !== undefined) spec.delegation = delegation;
  if (tokenBudget !== undefined) spec.tokenBudget = tokenBudget;
  if (timeBudgetSeconds !== undefined) spec.timeBudgetSeconds = timeBudgetSeconds;
  return spec;
}

export function validateTeamSpec(value: unknown, options: { expectedId?: string } = {}): string[] {
  try {
    const spec = loadTeamSpec(value);
    if (options.expectedId !== undefined && spec.id !== options.expectedId) {
      return [`id "${spec.id}" must match team directory "${options.expectedId}"`];
    }
    return [];
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}

export async function loadTeamSpecFile(filePath: string): Promise<TeamSpec> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    throw new TeamSpecError(`Unable to read team spec at ${filePath}: ${errorMessage(error)}`);
  }
  return parseTeamSpecJson(contents, filePath);
}

export async function parseTeamSpecFile(filePath: string): Promise<TeamSpec> {
  const spec = await loadTeamSpecFile(filePath);
  const expectedId = basename(dirname(resolve(filePath)));
  if (spec.id !== expectedId) {
    throw new TeamSpecError(`TeamSpec id "${spec.id}" must match team directory "${expectedId}"`);
  }
  return spec;
}

export async function findTeamSpecFromPersonaDir(personaDir: string): Promise<TeamSpec | null> {
  const filePath = join(personaDir, TEAM_SPEC_FILENAME);
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new TeamSpecError(`Unable to read team spec at ${filePath}: ${errorMessage(error)}`);
  }
  return parseTeamSpecJson(contents, filePath);
}

export async function loadTeamSpecFromPersonaDir(personaDir: string): Promise<TeamSpec> {
  const spec = await findTeamSpecFromPersonaDir(personaDir);
  if (!spec) throw new TeamSpecError(`No ${TEAM_SPEC_FILENAME} found in persona directory ${personaDir}`);
  return spec;
}

function parseTeamSpecJson(contents: string, sourcePath: string): TeamSpec {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents) as unknown;
  } catch (error) {
    throw new TeamSpecError(`Invalid JSON in ${sourcePath}: ${errorMessage(error)}`);
  }
  try {
    return loadTeamSpec(parsed);
  } catch (error) {
    if (error instanceof TeamSpecError) throw new TeamSpecError(`Invalid team spec in ${sourcePath}: ${error.message}`);
    throw error;
  }
}

function parseMember(value: unknown, index: number): TeamMember {
  if (!isRecord(value)) throw new TeamSpecError(`members[${index}] must be an object`);
  assertKnownKeys(value, new Set(['name', 'persona', 'role', 'owns']), `members[${index}]`);
  const member: TeamMember = {
    name: requireNonEmptyString(value.name, `members[${index}].name`),
    persona: parsePersonaRef(value.persona, `members[${index}].persona`)
  };
  const role = optionalNonEmptyString(value.role, `members[${index}].role`);
  const owns = parseRecordArray(value.owns, `members[${index}].owns`);
  if (role !== undefined) member.role = role;
  if (owns !== undefined) member.owns = owns;
  return member;
}

function parsePersonaRef(value: unknown, path: string): PersonaRef {
  if (typeof value === 'string') return requireNonEmptyString(value, path);
  if (!isRecord(value)) throw new TeamSpecError(`${path} must be a string or object`);
  assertKnownKeys(value, new Set(['slug', 'version', 'path', 'inline']), path);
  const slug = optionalNonEmptyString(value.slug, `${path}.slug`);
  const pathRef = optionalNonEmptyString(value.path, `${path}.path`);
  let version: string | number | undefined;
  if (value.version !== undefined) {
    if (typeof value.version === 'string') {
      version = value.version.trim();
      if (!version) throw new TeamSpecError(`${path}.version must be a non-empty string or positive integer`);
    } else if (typeof value.version !== 'number' || !Number.isInteger(value.version) || value.version <= 0) {
      throw new TeamSpecError(`${path}.version must be a non-empty string or positive integer`);
    } else version = value.version;
  }
  let inline: Record<string, unknown> | undefined;
  if (value.inline !== undefined) {
    if (!isRecord(value.inline)) throw new TeamSpecError(`${path}.inline must be an object`);
    inline = value.inline;
  }
  const optional = {
    ...(version !== undefined ? { version } : {}),
    ...(pathRef !== undefined ? { path: pathRef } : {}),
    ...(inline !== undefined ? { inline } : {})
  };
  if (slug !== undefined) return { slug, ...optional };
  if (pathRef !== undefined) return { path: pathRef, ...(version !== undefined ? { version } : {}), ...(inline !== undefined ? { inline } : {}) };
  if (inline !== undefined) return { inline, ...(version !== undefined ? { version } : {}) };
  throw new TeamSpecError(`${path} must include slug, path, or inline`);
}

function parseRecordArray(value: unknown, path: string): Record<string, unknown>[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new TeamSpecError(`${path} must be an array`);
  const entries: Record<string, unknown>[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    if (!isRecord(entry)) throw new TeamSpecError(`${path}[${index}] must be an object`);
    entries.push(entry);
  }
  return entries;
}

function optionalPositiveInteger(value: unknown, path: string): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0 || value > POSTGRES_INTEGER_MAX) {
    throw new TeamSpecError(`${path} must be a positive 32-bit integer`);
  }
  return value;
}

function optionalNonEmptyString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : requireNonEmptyString(value, path);
}

function requireNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new TeamSpecError(`${path} must be a non-empty string`);
  return value.trim();
}

function stableJson(value: unknown): string {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new TeamSpecError(`${path}.${key} is not a known field`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}
