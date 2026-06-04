/**
 * CHECKED-IN COPY of cloud's envelope contract anchor.
 *
 * Source: AgentWorkforce/cloud
 * `packages/web/lib/proactive-runtime/deployment-trigger-delivery.ts`
 * `ENVELOPE_FIELDS` (cloud#1841). Cloud pins `buildEnvelope`'s actual output
 * to that constant with a unit test whose failure message points here; this
 * repo pins `RawGatewayEnvelope` against this copy in
 * `shim.contract.test.ts`. A field added on either side without updating
 * BOTH fails CI on that side — drift cannot widen silently (workforce#189).
 *
 * Update procedure: change cloud's ENVELOPE_FIELDS + this file + the
 * RawGatewayEnvelope type (and RAW_GATEWAY_ENVELOPE_FIELDS) in the same
 * cross-repo change set.
 */
export const CLOUD_ENVELOPE_FIELDS = {
  always: ["id", "workspace", "type", "occurredAt", "attempt", "name", "cron", "resource"],
  optional: ["provider", "eventType", "deliveryId", "paths", "summary", "resumeContext"],
} as const;
