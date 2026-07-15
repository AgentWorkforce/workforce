import { getEventContract } from './registry.js';
import type { DecodedEventFrame, EventCompatibilityInfo, EventFrameV1, LegacyRawGatewayEnvelope, ValidationResult } from './types.js';
import { EventValidationError, assertEventFrameV1, isRecord, validateEventFrameV1 } from './validate.js';

export const LEGACY_RAW_GATEWAY_ENVELOPE_FIELDS = Object.freeze([
  'id', 'workspace', 'type', 'occurredAt', 'attempt', 'resource', 'summary', 'expand',
  'digest', 'name', 'cron', 'provider', 'eventType', 'deliveryId', 'paths',
  'resumeContext', 'harnessSession', 'channel', 'messageId', 'threadId'
] as const);
const LEGACY_FIELDS = new Set<string>(LEGACY_RAW_GATEWAY_ENVELOPE_FIELDS);

export const LEGACY_EVENT_TYPE_ALIASES = Object.freeze({
  'github.issue.labeled': 'github.issues.labeled',
  'github.pull_request.open': 'github.pull_request.opened',
  'slack.message': 'slack.message.created',
  'linear.issue.create': 'linear.issue.created',
  user_reply: 'relaycast.message'
} as const);

export function parseEventFrame(input: unknown): EventFrameV1 {
  assertEventFrameV1(input);
  const contract = getEventContract(input.type, input.contractVersion);
  if (!contract) throw new EventValidationError([{ path: '$.type', message: `unknown Event contract ${input.type}@${input.contractVersion}`, keyword: 'contract' }]);
  const result = contract.validate(input);
  if (!result.valid) throw new EventValidationError(result.errors);
  return input;
}

export function safeParseEventFrame(input: unknown): { success: true; data: EventFrameV1 } | { success: false; error: EventValidationError } {
  try {
    return { success: true, data: parseEventFrame(input) };
  } catch (error) {
    return { success: false, error: error instanceof EventValidationError ? error : new EventValidationError([{ path: '$', message: error instanceof Error ? error.message : String(error) }]) };
  }
}

export function validateRegisteredEventFrame(input: unknown): ValidationResult {
  const base = validateEventFrameV1(input);
  if (!base.valid || !isRecord(input)) return base;
  const contract = getEventContract(String(input.type), Number(input.contractVersion));
  if (!contract) return { valid: false, errors: [{ path: '$.type', message: `unknown Event contract ${String(input.type)}@${String(input.contractVersion)}`, keyword: 'contract' }] };
  return contract.validate(input as unknown as EventFrameV1);
}

export function decodeEventFrame(input: unknown): DecodedEventFrame {
  if (isRecord(input) && 'schemaVersion' in input) return { frame: parseEventFrame(input) };
  return decodeLegacyRawGatewayEnvelope(input);
}

export function decodeLegacyRawGatewayEnvelope(input: unknown): DecodedEventFrame {
  if (!isRecord(input)) throw new EventValidationError([{ path: '$', message: 'legacy gateway envelope must be an object', keyword: 'type' }]);
  const legacy = input as LegacyRawGatewayEnvelope;
  requireString(legacy.id, '$.id');
  requireString(legacy.workspace, '$.workspace');
  requireString(legacy.type, '$.type');
  requireString(legacy.occurredAt, '$.occurredAt');

  const originalType = legacy.type;
  const aliased = (LEGACY_EVENT_TYPE_ALIASES as Readonly<Record<string, string>>)[originalType];
  const type = aliased ?? originalType;
  const contract = getEventContract(type, 1);
  if (!contract) throw new EventValidationError([{ path: '$.type', message: `unknown legacy Event contract ${type}@1`, keyword: 'contract' }]);

  const provider = nonEmpty(legacy.provider) ?? contract.provider;
  const canonicalResource = isCanonicalResource(legacy.resource) ? legacy.resource : undefined;
  const messageId = nonEmpty(legacy.messageId) ?? nestedString(legacy.resource, 'messageId') ?? nestedString(legacy.resource, 'message', 'id');
  const channel = nonEmpty(legacy.channel) ?? nestedString(legacy.resource, 'channel');
  const threadId = nonEmpty(legacy.threadId) ?? nestedString(legacy.resource, 'threadId') ?? nestedString(legacy.resumeContext, 'threadId');
  const resourceId = canonicalResource?.id ?? messageId ?? nonEmpty(legacy.deliveryId) ?? (type === 'cron.tick' ? nonEmpty(legacy.name) : undefined) ?? legacy.id;
  const path = canonicalResource?.path ?? firstPath(legacy.paths) ?? deriveLegacyPath(type, provider, contract.resourceKind, resourceId, channel);
  const preserved = Object.keys(input).filter((key) => !LEGACY_FIELDS.has(key));
  const aliasesApplied = aliased ? [`${originalType} -> ${type}`] : [];
  const compatibility: EventCompatibilityInfo = {
    source: 'legacy-raw-gateway-envelope',
    originalType,
    aliasesApplied,
    preservedFields: preserved,
    ...(Object.hasOwn(input, 'compatibility') ? { originalCompatibility: input.compatibility } : {})
  };
  const legacyExtensions: Record<string, unknown> = {};
  for (const key of preserved) defineDataProperty(legacyExtensions, key, input[key]);
  for (const key of ['expand', 'resumeContext', 'harnessSession', 'eventType'] as const) {
    if (legacy[key] !== undefined) defineDataProperty(legacyExtensions, key, legacy[key]);
  }
  defineDataProperty(legacyExtensions, 'compatibility', compatibility);

  const frame: EventFrameV1 = {
    schemaVersion: 1,
    id: legacy.id,
    workspace: legacy.workspace,
    type,
    contractVersion: 1,
    occurredAt: legacy.occurredAt,
    attempt: Number.isInteger(legacy.attempt) && (legacy.attempt as number) > 0 ? legacy.attempt as number : 1,
    resource: canonicalResource ?? { path, kind: contract.resourceKind, id: resourceId, provider },
    summary: isRecord(legacy.summary) ? legacy.summary : {},
    ...(legacy.deliveryId ? { delivery: { id: legacy.deliveryId } } : {}),
    ...(!canonicalResource && legacy.resource !== undefined ? { payload: legacy.resource } : {}),
    ...(Array.isArray(legacy.paths) ? { paths: legacy.paths.filter((item): item is string => typeof item === 'string') } : {}),
    ...(typeof legacy.digest === 'string' ? { digest: legacy.digest } : {}),
    ...(type === 'cron.tick' ? { schedule: { name: nonEmpty(legacy.name) ?? resourceId, ...(nonEmpty(legacy.cron) ? { cron: legacy.cron } : {}) } } : {}),
    ...((channel || messageId || threadId) ? { message: { ...(channel ? { channel } : {}), ...(messageId ? { messageId } : {}), ...(threadId ? { threadId } : {}) } } : {}),
    extensions: legacyExtensions
  };
  return { frame: parseEventFrame(frame), compatibility };
}

function isCanonicalResource(value: unknown): value is EventFrameV1['resource'] {
  if (!isRecord(value)) return false;
  const keys = ['path', 'kind', 'id', 'provider'] as const;
  return Object.keys(value).length === keys.length && keys.every((key) => typeof value[key] === 'string');
}

function deriveLegacyPath(type: string, provider: string, kind: string, id: string, channel?: string): string {
  if (type === 'cron.tick') return `/cron/schedules/${encodeURIComponent(id)}`;
  if (type === 'relaycast.message') return `/relaycast/${encodeURIComponent(channel ?? 'dm')}/messages/${encodeURIComponent(id)}`;
  const kindSegments = kind.split('.').filter(Boolean);
  if (kindSegments[0] === provider) kindSegments.shift();
  const resourceSegments = kindSegments.length > 0 ? kindSegments : ['resources'];
  return `/${encodeURIComponent(provider)}/${resourceSegments.map(encodeURIComponent).join('/')}/${encodeURIComponent(id)}`;
}

function defineDataProperty(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

function firstPath(value: unknown): string | undefined {
  return Array.isArray(value) ? value.find((item): item is string => typeof item === 'string') : undefined;
}

function nestedString(value: unknown, ...path: string[]): string | undefined {
  let cursor: unknown = value;
  for (const part of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[part];
  }
  return nonEmpty(cursor);
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireString(value: unknown, path: string): asserts value is string {
  if (!nonEmpty(value)) throw new EventValidationError([{ path, message: 'must be a non-empty string', keyword: 'minLength' }]);
}
