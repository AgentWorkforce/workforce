import type {
  ManagedScheduleContext,
  ScheduleAtOptions,
  ScheduleContext,
  ScheduleRecord,
  ScheduleStatus
} from './types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 20_000;

export interface CloudScheduleContextOptions {
  baseUrl: string;
  token: string;
  workspaceId: string;
  agentId: string;
  requestTimeoutMs?: number;
  fetch?: typeof fetch;
  randomUUID?: () => string;
}

interface ScheduleResponse {
  schedule?: unknown;
  schedules?: unknown;
  error?: unknown;
  code?: unknown;
}

/**
 * Create the managed-cloud implementation behind `ctx.schedule`.
 *
 * Registration only resolves after Cloud returns an active durable schedule.
 * The deployment API token is scoped to the current workspace/agent by Cloud,
 * and the route performs the same ownership checks again.
 */
export function createCloudScheduleContext(
  options: CloudScheduleContextOptions
): ManagedScheduleContext {
  const baseUrl = requiredBaseUrl(options.baseUrl);
  const token = required(options.token, 'token');
  const workspaceId = required(options.workspaceId, 'workspaceId');
  const agentId = required(options.agentId, 'agentId');
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetch ?? fetch;
  const randomUUID = options.randomUUID ?? (() => crypto.randomUUID());
  const endpoint =
    `${baseUrl}/api/v1/workspaces/${encodeURIComponent(workspaceId)}` +
    `/deployments/${encodeURIComponent(agentId)}/schedules`;

  async function request(
    url: string,
    init: RequestInit
  ): Promise<{ response: Response; body: ScheduleResponse | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImpl(url, {
        ...init,
        headers: {
          authorization: `Bearer ${token}`,
          ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...init.headers
        },
        signal: controller.signal
      });
      const body = response.status === 204
        ? null
        : await response.json().catch(() => null) as ScheduleResponse | null;
      if (!response.ok) {
        const detail = responseDetail(body, response.status);
        throw new Error(`Cloud schedule request failed (${response.status}): ${detail}`);
      }
      return { response, body };
    } catch (error) {
      if (isAbortError(error)) {
        throw new Error(`Cloud schedule request timed out after ${requestTimeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function list(): Promise<ScheduleRecord[]> {
    const { body } = await request(endpoint, { method: 'GET' });
    if (!Array.isArray(body?.schedules)) {
      throw new Error('Cloud schedule list returned no schedules array');
    }
    return body.schedules.flatMap((value) => {
      try {
        return [parseScheduleRecord(value)];
      } catch {
        return [];
      }
    });
  }

  return {
    async at(when, payload, atOptions: ScheduleAtOptions = {}) {
      if (!(when instanceof Date) || Number.isNaN(when.getTime())) {
        throw new TypeError('schedule time must be a valid Date');
      }
      const name = atOptions.name?.trim() || `dynamic:${randomUUID()}`;
      const { body } = await request(endpoint, {
        method: 'POST',
        body: JSON.stringify({
          name,
          scheduledAt: when.toISOString(),
          timezone: atOptions.timezone?.trim() || 'UTC',
          payload: recordPayload(payload)
        })
      });
      const schedule = parseScheduleRecord(body?.schedule);
      if (schedule.status !== 'active') {
        throw new Error(
          `Cloud schedule registration returned status "${schedule.status}", expected "active"`
        );
      }
      return schedule;
    },

    async cancel(name) {
      const normalized = required(name, 'schedule name');
      await request(`${endpoint}?name=${encodeURIComponent(normalized)}`, {
        method: 'DELETE'
      });
    },

    list,

    async get(id) {
      const normalized = required(id, 'schedule id');
      return (await list()).find((schedule) => schedule.id === normalized) ?? null;
    }
  };
}

export function createDefaultCloudScheduleContext(input: {
  env: NodeJS.ProcessEnv;
  workspaceId: string;
  agentId: string;
  fetch?: typeof fetch;
}): ManagedScheduleContext | undefined {
  const baseUrl = firstNonEmpty(
    input.env.WORKFORCE_CLOUD_BASE_URL,
    input.env.WORKFORCE_CLOUD_URL,
    input.env.CLOUD_API_URL
  );
  const token = firstNonEmpty(
    input.env.WORKFORCE_WORKSPACE_TOKEN,
    input.env.WORKFORCE_AGENT_TOKEN,
    input.env.CLOUD_API_ACCESS_TOKEN
  );
  if (!baseUrl || !token || !input.workspaceId.trim() || !input.agentId.trim()) {
    return undefined;
  }
  try {
    return createCloudScheduleContext({
      baseUrl,
      token,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      ...(input.fetch ? { fetch: input.fetch } : {})
    });
  } catch {
    return undefined;
  }
}

export function isManagedScheduleContext(
  schedule: ScheduleContext
): schedule is ManagedScheduleContext {
  return (
    typeof schedule.list === 'function' &&
    typeof schedule.get === 'function'
  );
}

/** List durable schedules or fail clearly when the runner has no query API. */
export async function listSchedules(
  schedule: ScheduleContext
): Promise<ScheduleRecord[]> {
  if (!schedule.list) {
    throw new Error(
      'ctx.schedule.list is unavailable: connect the runner to Workforce Cloud'
    );
  }
  return schedule.list();
}

/** Read one durable schedule or fail clearly when the runner has no query API. */
export async function getSchedule(
  schedule: ScheduleContext,
  id: string
): Promise<ScheduleRecord | null> {
  if (!schedule.get) {
    throw new Error(
      'ctx.schedule.get is unavailable: connect the runner to Workforce Cloud'
    );
  }
  return schedule.get(id);
}

function parseScheduleRecord(value: unknown): ScheduleRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Cloud schedule response contained an invalid schedule');
  }
  const record = value as Record<string, unknown>;
  const status = parseStatus(record.status);
  return {
    id: requiredString(record.id, 'schedule.id'),
    name: requiredString(record.name, 'schedule.name'),
    scheduledAt: validTimestamp(record.scheduledAt, 'schedule.scheduledAt'),
    timezone: requiredString(record.timezone, 'schedule.timezone'),
    payload: recordPayload(record.payload),
    status,
    ...(typeof record.lastError === 'string' ? { lastError: record.lastError } : {}),
    ...(record.firedAt != null
      ? { firedAt: validTimestamp(record.firedAt, 'schedule.firedAt') }
      : {}),
    ...(record.cancelledAt != null
      ? { cancelledAt: validTimestamp(record.cancelledAt, 'schedule.cancelledAt') }
      : {}),
    ...(record.createdAt != null
      ? { createdAt: validTimestamp(record.createdAt, 'schedule.createdAt') }
      : {}),
    ...(record.updatedAt != null
      ? { updatedAt: validTimestamp(record.updatedAt, 'schedule.updatedAt') }
      : {})
  };
}

function parseStatus(value: unknown): ScheduleStatus {
  if (
    value === 'pending' ||
    value === 'active' ||
    value === 'fired' ||
    value === 'cancelled' ||
    value === 'cancellation_pending' ||
    value === 'failed'
  ) {
    return value;
  }
  throw new Error('Cloud schedule response contained an invalid schedule.status');
}

function recordPayload(value: unknown): Record<string, unknown> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('schedule payload must be an object');
  }
  return value as Record<string, unknown>;
}

function responseDetail(body: ScheduleResponse | null, status: number): string {
  const detail = body?.error ?? body?.code;
  return detail == null ? `HTTP ${status}` : String(detail).slice(0, 240);
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`Cloud schedule response missing ${name}`);
  }
  return value.trim();
}

function validTimestamp(value: unknown, name: string): string {
  const raw = requiredString(value, name);
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw new Error(`Cloud schedule response contained invalid ${name}`);
  }
  return date.toISOString();
}

function required(value: string, name: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${name} is required`);
  return normalized;
}

function requiredBaseUrl(value: string): string {
  const normalized = required(value, 'baseUrl').replace(/\/+$/, '');
  const url = new URL(normalized);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new TypeError('baseUrl must use http or https');
  }
  return normalized;
}

function firstNonEmpty(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (value?.trim()) return value.trim();
  }
  return undefined;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}
