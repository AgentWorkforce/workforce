/**
 * Compatibility input for the pre-EventFrame gateway wire format.
 *
 * @deprecated New producers and fixtures should use `EventFrameV1` from
 * `@agentworkforce/events`. This alias remains additive while Cloud migrates.
 */
export type { LegacyRawGatewayEnvelope as RawGatewayEnvelope } from '@agentworkforce/events';

/** @deprecated Derived from the canonical compatibility decoder package. */
export {
  LEGACY_RAW_GATEWAY_ENVELOPE_FIELDS as RAW_GATEWAY_ENVELOPE_FIELDS
} from '@agentworkforce/events';
