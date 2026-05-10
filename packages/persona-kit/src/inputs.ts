import type { PersonaInputSpec } from './types.js';

export type PersonaInputValues = Record<string, string | number | boolean | null | undefined>;

export interface PersonaInputResolution {
  values: Record<string, string>;
}

export class MissingPersonaInputError extends Error {
  readonly input: string;
  readonly env: string;
  constructor(input: string, env: string) {
    super(
      `Persona input ${input} is required but no explicit value, env var ${env}, or default was provided.`
    );
    this.name = 'MissingPersonaInputError';
    this.input = input;
    this.env = env;
  }
}

function stringifyProvidedValue(value: PersonaInputValues[string]): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value);
  return text === '' ? undefined : text;
}

export function resolvePersonaInputs(
  inputs: Record<string, PersonaInputSpec> | undefined,
  provided: PersonaInputValues | undefined,
  processEnv: NodeJS.ProcessEnv
): PersonaInputResolution {
  if (!inputs) return { values: {} };
  const values: Record<string, string> = {};
  for (const [name, spec] of Object.entries(inputs)) {
    const envName = spec.env ?? name;
    const resolved =
      stringifyProvidedValue(provided?.[name]) ??
      stringifyProvidedValue(processEnv[envName]) ??
      spec.default;
    if (resolved === undefined || resolved === '') {
      // Optional inputs substitute as empty so personas can write
      // sentinel-driven prompts (e.g. systemPrompt: "$TASK_DESCRIPTION")
      // that produce an empty rendered output when nothing is supplied.
      if (spec.optional) {
        values[name] = '';
        continue;
      }
      throw new MissingPersonaInputError(name, envName);
    }
    values[name] = resolved;
  }
  return { values };
}

function escapeRegExp(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function renderPersonaInputs(
  systemPrompt: string,
  values: Record<string, string>
): string {
  const names = Object.keys(values);
  if (names.length === 0) return systemPrompt;
  const alternatives = names
    .map(escapeRegExp)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const inputRef = new RegExp(
    `\\$\\{(${alternatives})\\}|\\$(${alternatives})(?![A-Z0-9_])`,
    'g'
  );
  return systemPrompt.replace(inputRef, (_match, bracedName, bareName) => {
    const name = (bracedName ?? bareName) as string;
    return values[name];
  });
}
