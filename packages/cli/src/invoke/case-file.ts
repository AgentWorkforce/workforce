import path from 'node:path';
import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import { decodeEventFrame } from '@agentworkforce/events';
import type { EventFrameV1 } from '@agentworkforce/events';
import type { EffectPolicyV1 } from '@agentworkforce/runtime';

export interface ParsedCaseHttpFixture {
  method: string;
  match: string;
  file: string;
}

export interface ParsedCaseExpectationProviderAction {
  provider: string;
  resource: string;
  channel?: string;
  threaded?: boolean;
  textContains?: string[];
}

export interface ParsedCaseExpectation {
  status?: 'succeeded' | 'failed';
  eventSource?: string;
  logsContain: string[];
  effectsContain: string[];
  providerActions: ParsedCaseExpectationProviderAction[];
}

export interface ParsedInvokeCase {
  schemaVersion: 1;
  id: string;
  agent?: string;
  kind: 'scheduled' | 'chat';
  events: EventFrameV1[];
  inputs: Record<string, string>;
  policy: Partial<EffectPolicyV1>;
  http: ParsedCaseHttpFixture[];
  expect: ParsedCaseExpectation;
  casePath: string;
}

export async function parseInvokeCase(casePath: string): Promise<ParsedInvokeCase> {
  const absPath = path.resolve(casePath);
  const raw = await readFile(absPath, 'utf8');
  const parsed = YAML.parse(raw) as unknown;
  return normalizeCase(absPath, parsed);
}

function normalizeCase(casePath: string, value: unknown): ParsedInvokeCase {
  const root = expectRecord(value, '$');
  assertOnlyKeys(root, '$', [
    'schemaVersion',
    'id',
    'agent',
    'kind',
    'event',
    'turns',
    'inputs',
    'policy',
    'http',
    'expect'
  ]);
  if (root.schemaVersion !== 1) throw new Error('$.schemaVersion: expected 1');
  const id = expectString(root.id, '$.id');
  const kind = expectEnum(root.kind, '$.kind', ['scheduled', 'chat'] as const);
  const eventValue = root.event;
  const turnsValue = root.turns;
  if ((eventValue === undefined) === (turnsValue === undefined)) {
    throw new Error('case: provide exactly one of $.event or $.turns');
  }

  const events = eventValue !== undefined
    ? [normalizeCaseEvent(eventValue, '$.event')]
    : expectArray(turnsValue, '$.turns').map((entry, index) => normalizeCaseEvent(entry, `$.turns[${index}]`));

  return {
    schemaVersion: 1,
    id,
    ...(typeof root.agent === 'string' ? { agent: root.agent } : {}),
    kind,
    events,
    inputs: normalizeStringMap(root.inputs, '$.inputs'),
    policy: normalizePolicy(root.policy, '$.policy'),
    http: normalizeHttpFixtures(root.http, casePath),
    expect: normalizeExpectation(root.expect, '$.expect'),
    casePath
  };
}

function normalizeCaseEvent(value: unknown, pathLabel: string): EventFrameV1 {
  const record = expectRecord(value, pathLabel);
  const type = expectString(record.type ?? (typeof record.schedule === 'string' ? 'cron.tick' : undefined), `${pathLabel}.type`);

  if (type === 'cron.tick') {
    const name = expectString(record.schedule ?? record.name, `${pathLabel}.schedule`);
    const cron = optionalString(record.cron);
    return decodeEventFrame({
      id: `${name}_${Math.random().toString(16).slice(2, 10)}`,
      workspace: 'ws-local',
      type: 'cron.tick',
      occurredAt: '2026-07-15T09:00:00.000Z',
      name,
      ...(cron ? { cron } : {})
    }).frame;
  }

  if (type.startsWith('slack.')) {
    const resource = expectRecord(record.resource ?? record, `${pathLabel}.resource`);
    const channel = expectString(resource.channel ?? record.channel, `${pathLabel}.channel`);
    const ts = expectString(resource.ts ?? record.ts, `${pathLabel}.ts`);
    const threadTs = optionalString(resource.thread_ts ?? resource.threadTs ?? record.thread_ts ?? record.threadTs);
    const text = expectString(resource.text ?? record.text, `${pathLabel}.text`);
    const user = expectString(resource.user ?? record.user, `${pathLabel}.user`);
    const token = ts.replace(/\./gu, '_');
    return decodeEventFrame({
      schemaVersion: 1,
      id: `slack_${token}`,
      workspace: 'ws-local',
      type: 'slack.message.created',
      contractVersion: 1,
      occurredAt: '2026-07-15T09:00:00.000Z',
      attempt: 1,
      resource: {
        path: `/slack/channels/${encodeURIComponent(channel)}/messages/${token}.json`,
        kind: 'slack.message',
        id: ts,
        provider: 'slack'
      },
      summary: { title: text.slice(0, 120), actor: user },
      message: {
        channel,
        messageId: ts,
        ...(threadTs ? { threadId: threadTs } : {})
      },
      payload: {
        channel,
        ts,
        ...(threadTs ? { thread_ts: threadTs } : {}),
        text,
        user,
        eventType: type
      }
    }).frame;
  }

  throw new Error(`${pathLabel}.type: unsupported case event type "${type}"`);
}

function normalizePolicy(value: unknown, pathLabel: string): Partial<EffectPolicyV1> {
  if (value === undefined) return {};
  const record = expectRecord(value, pathLabel);
  assertOnlyKeys(record, pathLabel, ['reads', 'writes', 'model', 'shell', 'compose']);
  const policy: Partial<EffectPolicyV1> = {};
  if (record.reads !== undefined) policy.reads = expectEnum(record.reads, `${pathLabel}.reads`, ['deny', 'fixtures', 'live'] as const);
  if (record.writes !== undefined) policy.writes = expectEnum(record.writes, `${pathLabel}.writes`, ['deny', 'preview', 'sandbox', 'live'] as const);
  if (record.model !== undefined) policy.model = expectEnum(record.model, `${pathLabel}.model`, ['stub', 'fixture', 'live'] as const);
  if (record.shell !== undefined) policy.shell = expectEnum(record.shell, `${pathLabel}.shell`, ['deny', 'simulate', 'sandbox', 'live'] as const);
  if (record.compose !== undefined) policy.compose = expectEnum(record.compose, `${pathLabel}.compose`, ['deny', 'preview', 'sandbox', 'live'] as const);
  return policy;
}

function normalizeHttpFixtures(value: unknown, casePath: string): ParsedCaseHttpFixture[] {
  if (value === undefined) return [];
  return expectArray(value, '$.http').map((entry, index) => {
    const record = expectRecord(entry, `$.http[${index}]`);
    assertOnlyKeys(record, `$.http[${index}]`, ['method', 'match', 'file']);
    return {
      method: expectString(record.method, `$.http[${index}].method`),
      match: expectString(record.match, `$.http[${index}].match`),
      file: path.resolve(path.dirname(casePath), expectString(record.file, `$.http[${index}].file`))
    };
  });
}

function normalizeExpectation(value: unknown, pathLabel: string): ParsedCaseExpectation {
  if (value === undefined) {
    return { logsContain: [], effectsContain: [], providerActions: [] };
  }
  const record = expectRecord(value, pathLabel);
  assertOnlyKeys(record, pathLabel, ['status', 'eventSource', 'logsContain', 'effectsContain', 'providerActions']);
  return {
    ...(record.status ? { status: expectEnum(record.status, `${pathLabel}.status`, ['succeeded', 'failed'] as const) } : {}),
    ...(record.eventSource ? { eventSource: expectString(record.eventSource, `${pathLabel}.eventSource`) } : {}),
    logsContain: normalizeStringArray(record.logsContain, `${pathLabel}.logsContain`),
    effectsContain: normalizeStringArray(record.effectsContain, `${pathLabel}.effectsContain`),
    providerActions: expectArray(record.providerActions ?? [], `${pathLabel}.providerActions`).map((entry, index) => {
      const action = expectRecord(entry, `${pathLabel}.providerActions[${index}]`);
      assertOnlyKeys(action, `${pathLabel}.providerActions[${index}]`, [
        'provider',
        'resource',
        'channel',
        'threaded',
        'textContains'
      ]);
      return {
        provider: expectString(action.provider, `${pathLabel}.providerActions[${index}].provider`),
        resource: expectString(action.resource, `${pathLabel}.providerActions[${index}].resource`),
        ...(action.channel ? { channel: expectString(action.channel, `${pathLabel}.providerActions[${index}].channel`) } : {}),
        ...(action.threaded !== undefined ? { threaded: Boolean(action.threaded) } : {}),
        ...(action.textContains ? { textContains: normalizeStringArray(action.textContains, `${pathLabel}.providerActions[${index}].textContains`) } : {})
      };
    })
  };
}

function normalizeStringMap(value: unknown, pathLabel: string): Record<string, string> {
  if (value === undefined) return {};
  const record = expectRecord(value, pathLabel);
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => {
      if (typeof entry !== 'string') throw new Error(`${pathLabel}.${key}: expected string`);
      return [key, entry];
    })
  );
}

function normalizeStringArray(value: unknown, pathLabel: string): string[] {
  return expectArray(value ?? [], pathLabel).map((entry, index) => expectString(entry, `${pathLabel}[${index}]`));
}

function expectRecord(value: unknown, pathLabel: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${pathLabel}: expected object`);
  }
  return value as Record<string, unknown>;
}

function expectArray(value: unknown, pathLabel: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${pathLabel}: expected array`);
  return value;
}

function expectString(value: unknown, pathLabel: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${pathLabel}: expected non-empty string`);
  return value;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function expectEnum<const T extends readonly string[]>(
  value: unknown,
  pathLabel: string,
  allowed: T
): T[number] {
  const text = expectString(value, pathLabel);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new Error(`${pathLabel}: expected one of ${allowed.join(', ')}`);
  }
  return text as T[number];
}

function assertOnlyKeys(value: Record<string, unknown>, pathLabel: string, allowed: readonly string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${pathLabel}.${key}: unknown field`);
  }
}
