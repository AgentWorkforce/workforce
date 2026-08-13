import type { Ajv2020 } from 'ajv/dist/2020.js';

export const COMPOSIO_TRIGGER_COORDINATES_KEYWORD =
  'x-agentworkforce-composio-trigger-message-v1-coordinates';

/**
 * Install the shared cross-field keywords used by exported Event contract schemas.
 *
 * JSON Schema cannot otherwise compare a resource path with a URL-encoded value
 * elsewhere in the frame. Consumers compiling EVENT_CONTRACT_JSON_SCHEMAS with
 * AJV must call this once on their AJV instance before adding the schemas.
 */
export function addEventContractJsonSchemaKeywords(ajv: Ajv2020): Ajv2020 {
  if (!ajv.getKeyword(COMPOSIO_TRIGGER_COORDINATES_KEYWORD)) {
    ajv.addKeyword({
      keyword: COMPOSIO_TRIGGER_COORDINATES_KEYWORD,
      type: 'object',
      schemaType: 'boolean',
      errors: false,
      validate(enabled: boolean, value: unknown): boolean {
        if (!enabled) return true;
        return hasCanonicalComposioTriggerCoordinates(value);
      }
    });
  }
  return ajv;
}

function hasCanonicalComposioTriggerCoordinates(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.resource) || !isRecord(value.delivery)) return false;
  if (!isRecord(value.payload) || !isRecord(value.payload.metadata)) return false;

  const triggerId = value.payload.metadata.trigger_id;
  const payloadId = value.payload.id;
  const timestamp = value.payload.timestamp;
  if (typeof triggerId !== 'string' || triggerId.length === 0) return false;
  if (typeof payloadId !== 'string' || payloadId.length === 0) return false;
  if (typeof timestamp !== 'string' || timestamp.length === 0) return false;

  return value.resource.id === triggerId
    && value.resource.path === `/composio/triggers/${encodeURIComponent(triggerId)}`
    && value.occurredAt === timestamp
    && value.delivery.id === payloadId
    && value.delivery.dedupeKey === payloadId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
