import type { JsonSchema } from './types.js';

const stringSchema = { type: 'string' } as const;
const nonEmptyStringSchema = { type: 'string', minLength: 1 } as const;

export const EVENT_SUMMARY_SCHEMA = {
  $id: 'https://agentworkforce.dev/schemas/events/event-summary.json',
  type: 'object',
  properties: {
    title: stringSchema,
    description: stringSchema,
    actor: stringSchema
  },
  additionalProperties: true
} as const satisfies JsonSchema;

/** Canonical JSON Schema export used by Cloud, fixtures, and replay tooling. */
export const EVENT_FRAME_V1_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://agentworkforce.dev/schemas/events/event-frame-v1.json',
  title: 'EventFrameV1',
  type: 'object',
  additionalProperties: false,
  required: [
    'schemaVersion',
    'id',
    'workspace',
    'type',
    'contractVersion',
    'occurredAt',
    'attempt',
    'resource',
    'summary'
  ],
  properties: {
    schemaVersion: { const: 1 },
    id: nonEmptyStringSchema,
    workspace: nonEmptyStringSchema,
    type: nonEmptyStringSchema,
    contractVersion: { type: 'integer', minimum: 1 },
    occurredAt: { type: 'string', format: 'date-time' },
    attempt: { type: 'integer', minimum: 1 },
    resource: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'kind', 'id', 'provider'],
      properties: {
        path: stringSchema,
        kind: nonEmptyStringSchema,
        id: nonEmptyStringSchema,
        provider: nonEmptyStringSchema
      }
    },
    summary: EVENT_SUMMARY_SCHEMA,
    delivery: {
      type: 'object',
      additionalProperties: false,
      properties: { id: stringSchema, dedupeKey: stringSchema }
    },
    payload: {},
    paths: { type: 'array', items: stringSchema },
    digest: stringSchema,
    schedule: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: nonEmptyStringSchema,
        cron: stringSchema,
        timezone: stringSchema,
        scheduledFor: { type: 'string', format: 'date-time' }
      }
    },
    message: {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: stringSchema,
        messageId: stringSchema,
        threadId: stringSchema
      }
    },
    extensions: { type: 'object', additionalProperties: true }
  }
} as const satisfies JsonSchema;

/** Derived from the schema so parsers and exported schema cannot drift. */
export const EVENT_FRAME_V1_FIELDS = Object.freeze(
  Object.keys(EVENT_FRAME_V1_SCHEMA.properties)
) as readonly (keyof typeof EVENT_FRAME_V1_SCHEMA.properties)[];
