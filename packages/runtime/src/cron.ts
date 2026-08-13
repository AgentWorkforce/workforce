/**
 * Stable cron view shared by handlers that may receive either the legacy v3
 * `{ source: 'cron' }` event or the normalized v4 `cron.tick` event.
 */
export interface NormalizedCronFire {
  /** Scheduled fire time, falling back to occurrence time and then now. */
  firedAt: Date;
  /** Human schedule name when the event model exposes one. */
  scheduleName?: string;
}

interface CronEventFields {
  type?: unknown;
  source?: unknown;
  scheduledFor?: unknown;
  occurredAt?: unknown;
  name?: unknown;
  resource?: unknown;
}

/**
 * Normalize cron events across the v3 and v4 runtime event models.
 *
 * Returns `null` for non-cron events. This intentionally does not gate on a
 * schedule name: single-schedule agents must still run when older deliveries
 * omit the name.
 */
export function normalizeCronFire(event: unknown): NormalizedCronFire | null {
  if (!isRecord(event)) return null;

  const fields = event as CronEventFields;
  const isV4 = fields.type === 'cron.tick';
  const isV3 = fields.source === 'cron';
  if (!isV4 && !isV3) return null;

  const scheduledFor = stringValue(fields.scheduledFor);
  const occurredAt = stringValue(fields.occurredAt);
  const scheduleName = isV4
    ? stringValue(isRecord(fields.resource) ? fields.resource.id : undefined)
    : stringValue(fields.name);

  return {
    firedAt: new Date(scheduledFor ?? occurredAt ?? Date.now()),
    ...(scheduleName ? { scheduleName } : {})
  };
}

/** Return the runtime event discriminant without coupling callers to a model. */
export function workforceEventType(event: unknown): string {
  if (!isRecord(event)) return 'unknown';
  return stringValue(event.type) ?? stringValue(event.source) ?? 'unknown';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}
