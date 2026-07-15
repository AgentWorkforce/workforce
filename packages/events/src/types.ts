export type JsonSchema = Readonly<Record<string, unknown>>;

/** Small, display-safe description of an Event. Provider-specific detail lives in payload. */
export interface EventSummary {
  title?: string;
  description?: string;
  actor?: string;
  [key: string]: unknown;
}

export interface EventFrameV1 {
  schemaVersion: 1;
  id: string;
  workspace: string;
  type: string;
  contractVersion: number;
  occurredAt: string;
  attempt: number;
  resource: {
    path: string;
    kind: string;
    id: string;
    provider: string;
  };
  summary: EventSummary;
  delivery?: {
    id?: string;
    dedupeKey?: string;
  };
  payload?: unknown;
  paths?: string[];
  digest?: string;
  schedule?: {
    name: string;
    cron?: string;
    timezone?: string;
    scheduledFor?: string;
  };
  message?: {
    channel?: string;
    messageId?: string;
    threadId?: string;
  };
  extensions?: Record<string, unknown>;
}

export interface ValidationIssue {
  path: string;
  message: string;
  keyword?: string;
}

export type ValidationResult =
  | { valid: true; errors: readonly [] }
  | { valid: false; errors: readonly ValidationIssue[] };

export interface EventContract<TPayload = unknown> {
  id: string;
  version: number;
  provider: string;
  trigger: string;
  resourceKind: string;
  summarySchema: JsonSchema;
  payloadSchema?: JsonSchema;
  fixtureExamples: readonly EventFrameV1[];
  redact(payload: TPayload): TPayload;
  validate(frame: EventFrameV1): ValidationResult;
}

/** The pre-EventFrame gateway shape retained only as an input compatibility contract. */
export interface LegacyRawGatewayEnvelope {
  id: string;
  workspace: string;
  type: string;
  occurredAt: string;
  attempt?: number;
  resource?: unknown;
  summary?: Record<string, unknown>;
  expand?: unknown;
  digest?: string;
  name?: string;
  cron?: string;
  provider?: string;
  eventType?: string;
  deliveryId?: string;
  paths?: string[];
  resumeContext?: unknown;
  harnessSession?: unknown;
  channel?: string;
  messageId?: string;
  threadId?: string;
  [key: string]: unknown;
}

export interface EventCompatibilityInfo {
  source: 'legacy-raw-gateway-envelope';
  originalType: string;
  aliasesApplied: readonly string[];
  preservedFields: readonly string[];
}

export interface DecodedEventFrame {
  frame: EventFrameV1;
  compatibility?: EventCompatibilityInfo;
}
