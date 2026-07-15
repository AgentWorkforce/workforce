import { EVENT_FRAME_V1_FIELDS } from './schemas.js';
import type { EventFrameV1, ValidationIssue, ValidationResult } from './types.js';

const TOP_LEVEL_FIELDS = new Set<string>(EVENT_FRAME_V1_FIELDS);

export class EventValidationError extends Error {
  readonly issues: readonly ValidationIssue[];

  constructor(issues: readonly ValidationIssue[]) {
    super(issues.map((issue) => `${issue.path}: ${issue.message}`).join('; '));
    this.name = 'EventValidationError';
    this.issues = issues;
  }
}

export function validateEventFrameV1(value: unknown): ValidationResult {
  const errors: ValidationIssue[] = [];
  if (!isRecord(value)) {
    return invalid([{ path: '$', message: 'must be an object', keyword: 'type' }]);
  }

  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_FIELDS.has(key)) {
      errors.push({ path: `$.${key}`, message: 'is not a known EventFrameV1 field; place extension data under $.extensions', keyword: 'additionalProperties' });
    }
  }

  if (value.schemaVersion !== 1) error(errors, '$.schemaVersion', 'must equal 1', 'const');
  requiredString(value.id, '$.id', errors);
  requiredString(value.workspace, '$.workspace', errors);
  requiredString(value.type, '$.type', errors);
  positiveInteger(value.contractVersion, '$.contractVersion', errors);
  requiredString(value.occurredAt, '$.occurredAt', errors);
  if (typeof value.occurredAt === 'string' && Number.isNaN(Date.parse(value.occurredAt))) {
    error(errors, '$.occurredAt', 'must be an ISO-8601 date-time', 'format');
  }
  positiveInteger(value.attempt, '$.attempt', errors);

  if (!isRecord(value.resource)) {
    error(errors, '$.resource', 'must be an object', 'type');
  } else {
    exactKeys(value.resource, new Set(['path', 'kind', 'id', 'provider']), '$.resource', errors);
    string(value.resource.path, '$.resource.path', errors);
    requiredString(value.resource.kind, '$.resource.kind', errors);
    requiredString(value.resource.id, '$.resource.id', errors);
    requiredString(value.resource.provider, '$.resource.provider', errors);
  }

  if (!isRecord(value.summary)) error(errors, '$.summary', 'must be an object', 'type');
  optionalRecord(value.delivery, '$.delivery', errors, new Set(['id', 'dedupeKey']));
  if (isRecord(value.delivery)) {
    optionalString(value.delivery.id, '$.delivery.id', errors);
    optionalString(value.delivery.dedupeKey, '$.delivery.dedupeKey', errors);
  }
  optionalStringArray(value.paths, '$.paths', errors);
  optionalString(value.digest, '$.digest', errors);
  optionalRecord(value.schedule, '$.schedule', errors, new Set(['name', 'cron', 'timezone', 'scheduledFor']));
  if (isRecord(value.schedule)) {
    requiredString(value.schedule.name, '$.schedule.name', errors);
    optionalString(value.schedule.cron, '$.schedule.cron', errors);
    optionalString(value.schedule.timezone, '$.schedule.timezone', errors);
    optionalString(value.schedule.scheduledFor, '$.schedule.scheduledFor', errors);
    if (typeof value.schedule.scheduledFor === 'string' && Number.isNaN(Date.parse(value.schedule.scheduledFor))) {
      error(errors, '$.schedule.scheduledFor', 'must be an ISO-8601 date-time', 'format');
    }
  }
  optionalRecord(value.message, '$.message', errors, new Set(['channel', 'messageId', 'threadId']));
  if (isRecord(value.message)) {
    optionalString(value.message.channel, '$.message.channel', errors);
    optionalString(value.message.messageId, '$.message.messageId', errors);
    optionalString(value.message.threadId, '$.message.threadId', errors);
  }
  if (value.extensions !== undefined && !isRecord(value.extensions)) {
    error(errors, '$.extensions', 'must be an object', 'type');
  }

  return errors.length === 0 ? { valid: true, errors: [] } : invalid(errors);
}

function optionalRecord(value: unknown, path: string, errors: ValidationIssue[], keys: Set<string>): void {
  if (value === undefined) return;
  if (!isRecord(value)) {
    error(errors, path, 'must be an object', 'type');
    return;
  }
  exactKeys(value, keys, path, errors);
}

function exactKeys(value: Record<string, unknown>, keys: Set<string>, path: string, errors: ValidationIssue[]): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) error(errors, `${path}.${key}`, 'is not a known field', 'additionalProperties');
  }
}

function optionalStringArray(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (value === undefined) return;
  if (!Array.isArray(value)) return error(errors, path, 'must be an array', 'type');
  value.forEach((item, index) => string(item, `${path}[${index}]`, errors));
}

function positiveInteger(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (!Number.isInteger(value) || (value as number) < 1) error(errors, path, 'must be a positive integer', 'minimum');
}

function optionalString(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (value !== undefined) string(value, path, errors);
}

function requiredString(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (typeof value !== 'string' || value.length === 0) error(errors, path, 'must be a non-empty string', 'minLength');
}

function string(value: unknown, path: string, errors: ValidationIssue[]): void {
  if (typeof value !== 'string') error(errors, path, 'must be a string', 'type');
}

function error(errors: ValidationIssue[], path: string, message: string, keyword: string): void {
  errors.push({ path, message, keyword });
}

function invalid(errors: ValidationIssue[]): ValidationResult {
  return { valid: false, errors };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function assertEventFrameV1(value: unknown): asserts value is EventFrameV1 {
  const result = validateEventFrameV1(value);
  if (!result.valid) throw new EventValidationError(result.errors);
}
