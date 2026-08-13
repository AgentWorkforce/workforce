import { validateJsonSchema } from './json-schema.js';
import { EVENT_FRAME_V1_SCHEMA } from './schemas.js';
import type { EventFrameV1, ValidationIssue, ValidationResult } from './types.js';

export class EventValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'EventValidationError';
    this.issues = issues;
  }
}

export function validateEventFrameV1(value: unknown): ValidationResult {
  return validateJsonSchema(EVENT_FRAME_V1_SCHEMA, value);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertEventFrameV1(value: unknown): asserts value is EventFrameV1 {
  const result = validateEventFrameV1(value);
  if (!result.valid) throw new EventValidationError(result.errors);
}
