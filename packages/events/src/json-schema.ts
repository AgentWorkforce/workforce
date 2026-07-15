import addFormatsModule from 'ajv-formats';
import { Ajv2020, type ErrorObject, type ValidateFunction } from 'ajv/dist/2020.js';
import type { JsonSchema, ValidationIssue, ValidationResult } from './types.js';

const ajv = new Ajv2020({ allErrors: true, strict: true });
(addFormatsModule as unknown as (instance: Ajv2020) => Ajv2020)(ajv);

const validators = new WeakMap<object, ValidateFunction>();

/** Validate against the same JSON Schema objects exported to consumers. */
export function validateJsonSchema(schema: JsonSchema, value: unknown, path = '$'): ValidationResult {
  const cached = validators.get(schema);
  const validator = cached ?? ajv.compile(withoutSchemaIdentifiers(schema));
  if (!cached) validators.set(schema, validator);
  if (validator(value)) return { valid: true, errors: [] };
  return {
    valid: false,
    errors: (validator.errors ?? []).map((issue) => toValidationIssue(issue, path))
  };
}

/** Remove registration identifiers when a schema is embedded or compiled in a shared catalog. */
export function withoutSchemaIdentifiers(schema: JsonSchema): JsonSchema {
  return stripIdentifiers(schema) as JsonSchema;
}

function stripIdentifiers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripIdentifiers);
  if (typeof value !== 'object' || value === null) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== '$id' && key !== '$schema')
    .map(([key, child]) => [key, stripIdentifiers(child)]));
}

function toValidationIssue(issue: ErrorObject, root: string): ValidationIssue {
  const pointer = issue.instancePath
    .split('/')
    .slice(1)
    .map(unescapePointer)
    .map((part) => /^\d+$/.test(part) ? `[${part}]` : `.${part}`)
    .join('');
  const additional = issue.keyword === 'additionalProperties'
    ? `.${String((issue.params as { additionalProperty?: unknown }).additionalProperty ?? '')}`
    : '';
  return {
    path: `${root}${pointer}${additional}`,
    message: issue.message ?? 'is invalid',
    keyword: issue.keyword
  };
}

function unescapePointer(value: string): string {
  return value.replaceAll('~1', '/').replaceAll('~0', '~');
}
