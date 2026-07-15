import { redactEventValue } from './redact.js';
import { EVENT_FRAME_V1_SCHEMA, EVENT_SUMMARY_SCHEMA } from './schemas.js';
import type { EventContract, EventFrameV1, JsonSchema, ValidationIssue, ValidationResult } from './types.js';
import { validateEventFrameV1 } from './validate.js';

const OPEN_PAYLOAD_SCHEMA = { type: 'object', additionalProperties: true } as const;

function example(
  id: string,
  provider: string,
  trigger: string,
  resourceKind: string,
  overrides: Partial<EventFrameV1> = {}
): EventFrameV1 {
  return {
    schemaVersion: 1,
    id: `evt_${id.replaceAll('.', '_')}`,
    workspace: 'ws_example',
    type: id,
    contractVersion: 1,
    occurredAt: '2026-07-15T09:00:00.000Z',
    attempt: 1,
    resource: {
      path: `/${provider}/${resourceKind.slice(provider.length + 1).replaceAll('.', 's/')}/example`,
      kind: resourceKind,
      id: 'example',
      provider
    },
    summary: { title: `${id} example` },
    payload: { action: trigger.split('.').at(-1) },
    ...overrides
  };
}

function contract<TPayload = unknown>(config: {
  id: string;
  provider: string;
  trigger: string;
  resourceKind: string;
  fixture: EventFrameV1;
  payloadSchema?: JsonSchema;
}): EventContract<TPayload> {
  return Object.freeze({
    id: config.id,
    version: 1,
    provider: config.provider,
    trigger: config.trigger,
    resourceKind: config.resourceKind,
    summarySchema: EVENT_SUMMARY_SCHEMA,
    payloadSchema: config.payloadSchema ?? OPEN_PAYLOAD_SCHEMA,
    fixtureExamples: Object.freeze([config.fixture]),
    redact: (payload: TPayload) => redactEventValue(payload),
    validate(frame: EventFrameV1): ValidationResult {
      const base = validateEventFrameV1(frame);
      if (!base.valid) return base;
      const errors: ValidationIssue[] = [];
      if (frame.type !== config.id) errors.push({ path: '$.type', message: `must equal ${config.id}`, keyword: 'const' });
      if (frame.contractVersion !== 1) errors.push({ path: '$.contractVersion', message: 'must equal 1', keyword: 'const' });
      if (frame.resource.provider !== config.provider) errors.push({ path: '$.resource.provider', message: `must equal ${config.provider}`, keyword: 'const' });
      if (frame.resource.kind !== config.resourceKind) errors.push({ path: '$.resource.kind', message: `must equal ${config.resourceKind}`, keyword: 'const' });
      return errors.length === 0 ? { valid: true, errors: [] } : { valid: false, errors };
    }
  });
}

export const EVENT_CONTRACTS = Object.freeze([
  contract({
    id: 'cron.tick',
    provider: 'cron',
    trigger: 'tick',
    resourceKind: 'cron.schedule',
    fixture: example('cron.tick', 'cron', 'tick', 'cron.schedule', {
      resource: { path: '/cron/schedules/scan', kind: 'cron.schedule', id: 'scan', provider: 'cron' },
      summary: { title: 'Scheduled scan' },
      schedule: { name: 'scan', cron: '0 9 * * *', timezone: 'UTC', scheduledFor: '2026-07-15T09:00:00.000Z' },
      payload: undefined
    })
  }),
  contract({
    id: 'github.issues.labeled',
    provider: 'github',
    trigger: 'issues.labeled',
    resourceKind: 'github.issue',
    fixture: example('github.issues.labeled', 'github', 'issues.labeled', 'github.issue', {
      resource: { path: '/github/repos/acme/app/issues/42.json', kind: 'github.issue', id: '42', provider: 'github' },
      summary: { title: 'Issue #42 labeled bug', actor: 'octocat' },
      payload: { action: 'labeled', issue: { number: 42 }, label: { name: 'bug' } }
    })
  }),
  contract({
    id: 'github.pull_request.opened',
    provider: 'github',
    trigger: 'pull_request.opened',
    resourceKind: 'github.pull_request',
    fixture: example('github.pull_request.opened', 'github', 'pull_request.opened', 'github.pull_request', {
      resource: { path: '/github/repos/acme/app/pulls/7.json', kind: 'github.pull_request', id: '7', provider: 'github' },
      summary: { title: 'PR #7 opened', actor: 'octocat' },
      payload: { action: 'opened', pull_request: { number: 7 } }
    })
  }),
  contract({
    id: 'slack.message.created',
    provider: 'slack',
    trigger: 'message.created',
    resourceKind: 'slack.message',
    fixture: example('slack.message.created', 'slack', 'message.created', 'slack.message', {
      resource: { path: '/slack/channels/C123/messages/171.json', kind: 'slack.message', id: '171', provider: 'slack' },
      summary: { title: 'New Slack message', actor: 'U123' },
      message: { channel: 'C123', messageId: '171' },
      payload: { channel: 'C123', user: 'U123', text: 'hello' }
    })
  }),
  contract({
    id: 'linear.issue.created',
    provider: 'linear',
    trigger: 'issue.created',
    resourceKind: 'linear.issue',
    fixture: example('linear.issue.created', 'linear', 'issue.created', 'linear.issue', {
      resource: { path: '/linear/issues/ENG-1.json', kind: 'linear.issue', id: 'ENG-1', provider: 'linear' },
      summary: { title: 'ENG-1 created', actor: 'user@example.com' },
      payload: { action: 'create', issue: { identifier: 'ENG-1', title: 'Ship it' } }
    })
  }),
  contract({
    id: 'relaycast.message',
    provider: 'relaycast',
    trigger: 'message',
    resourceKind: 'relaycast.message',
    fixture: example('relaycast.message', 'relaycast', 'message', 'relaycast.message', {
      resource: { path: '/relaycast/general/messages/msg_1', kind: 'relaycast.message', id: 'msg_1', provider: 'relaycast' },
      summary: { title: 'Can you take a look?' },
      message: { channel: 'general', messageId: 'msg_1', threadId: 'thread_1' },
      payload: { text: 'Can you take a look?' }
    })
  })
] as const satisfies readonly EventContract[]);

const BY_KEY = new Map(EVENT_CONTRACTS.map((entry) => [`${entry.id}@${entry.version}`, entry]));

export function getEventContract(id: string, version = 1): EventContract | undefined {
  return BY_KEY.get(`${id}@${version}`);
}

export function requireEventContract(id: string, version = 1): EventContract {
  const entry = getEventContract(id, version);
  if (!entry) throw new Error(`Unknown Event contract: ${id}@${version}`);
  return entry;
}

export const EVENT_CONTRACT_JSON_SCHEMAS = Object.freeze(Object.fromEntries(
  EVENT_CONTRACTS.map((entry) => [
    `${entry.id}@${entry.version}`,
    {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $id: `https://agentworkforce.dev/schemas/events/${entry.id}/v${entry.version}.json`,
      allOf: [
        EVENT_FRAME_V1_SCHEMA,
        {
          type: 'object',
          properties: {
            type: { const: entry.id },
            contractVersion: { const: entry.version },
            resource: {
              type: 'object',
              properties: {
                provider: { const: entry.provider },
                kind: { const: entry.resourceKind }
              }
            },
            summary: entry.summarySchema,
            ...(entry.payloadSchema ? { payload: entry.payloadSchema } : {})
          }
        }
      ]
    } satisfies JsonSchema
  ])
));
