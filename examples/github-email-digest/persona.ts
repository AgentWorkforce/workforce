/**
 * Typed persona authoring with `definePersona`.
 *
 * Authoring the persona as TypeScript (instead of hand-writing persona.json)
 * gets you compile-time validation AND editor autocomplete for provider trigger
 * names — see the `integrations` block (and ../slack-reaction-archiver for a
 * persona that subscribes to a slack trigger). That autocomplete is powered by
 * PR #113 (the `@relayfile/adapter-core/triggers`
 * subpath export → `KNOWN_TRIGGER_CATALOG`), which `@agentworkforce/persona-kit`
 * re-exposes through `definePersona`'s `TriggerNameFor<P>` type.
 *
 * Compile to the runtime artifact (persona.json) with:
 *   agentworkforce persona compile ./persona.ts
 */
import { definePersona } from '@agentworkforce/persona-kit'; // ≥ 3.0.23

/**
 * Cloud integration provider ids — the source of truth is the Relayfile connect
 * registry (what `agentworkforce deploy --mode cloud` accepts). Note Gmail's id
 * is `google-mail`, NOT `gmail` (`gmail` is only the adapter slug): deploying
 * with `gmail` fails connect with `409 unknown_provider`.
 *
 * persona-kit doesn't yet constrain `integrations` keys, so we pin them here:
 * the `satisfies` below turns a wrong key into a COMPILE error with autocomplete
 * of the valid ids — instead of a deploy-time 409. (Workspaces can also expose
 * named aliases like `slack-nightcto`; the registry is authoritative.)
 */
type IntegrationProvider =
  | 'github' | 'gitlab' | 'hubspot' | 'x' | 'slack' | 'notion' | 'linear'
  | 'jira' | 'confluence' | 'google-mail' | 'google-calendar' | 'granola'
  | 'fathom' | 'docker-hub';

interface IntegrationCfg {
  source?: string;
  scope?: Record<string, string>;
  triggers?: readonly { on: string; match?: string; where?: string }[];
}

// Key-checked integrations. `gmail: {}` here would be a compile error — try it.
const integrations = {
  'google-mail': {}, // Gmail VFS, mounted at /google-mail
  slack: {} // typed ctx.slack client for the DM
} satisfies Partial<Record<IntegrationProvider, IntegrationCfg>>;

export default definePersona({
  id: 'github-email-digest',
  intent: 'relay-orchestrator',
  tags: ['documentation', 'discovery'],
  description:
    'Proactive agent: 3×/day, summarizes new GitHub emails from your Gmail inbox, DMs you the digest on Slack, and archives only the messages you approve (by labelling them).',
  cloud: true,

  // `google-mail` mounts the Gmail VFS at /google-mail so the handler can read
  // inbox messages and issue the archive writeback; `slack` gives the handler
  // the typed ctx.slack client for the DM. No triggers here — schedule-driven
  // (below). See ../slack-reaction-archiver for trigger `on` autocomplete.
  integrations,

  // Three times a day. cron is "minute hour … " — 08:00, 13:00, 18:00.
  // Change `tz` to your timezone (IANA name); it defaults to UTC otherwise.
  schedules: [{ name: 'digest', cron: '0 8,13,18 * * *', tz: 'America/New_York' }],

  inputs: {
    SLACK_USER: {
      description: 'Your Slack user id (e.g. U0123ABCD) — the agent DMs you here.',
      env: 'SLACK_USER'
    },
    GMAIL_ACCOUNT: {
      description: 'Gmail account segment under the Gmail VFS root.',
      env: 'GMAIL_ACCOUNT',
      default: 'me'
    },
    GMAIL_VFS_ROOT: {
      description: 'Where the Gmail provider is mounted (connect registry: /google-mail).',
      env: 'GMAIL_VFS_ROOT',
      default: '/google-mail'
    },
    APPROVAL_LABEL: {
      description: 'Gmail label you apply to approve a message for archiving.',
      env: 'APPROVAL_LABEL',
      default: 'Archive-Approved'
    },
    GITHUB_SENDERS: {
      description: 'Comma-separated sender substrings that count as "from GitHub".',
      env: 'GITHUB_SENDERS',
      default: 'notifications@github.com,noreply@github.com,@github.com'
    },
    DRY_RUN: {
      description: 'Set "true" to compose + DM the digest but never write the archive.',
      env: 'DRY_RUN',
      default: 'false'
    },
    FORCE_DM: {
      description: 'Set "true" to DM a heartbeat even when there are no new emails (test aid).',
      env: 'FORCE_DM',
      default: 'false'
    }
  },

  // Used by ctx.llm.complete() in the handler to summarize the emails. Swap to
  // a larger model if you want richer digests; haiku keeps a thrice-daily job cheap.
  harness: 'claude',
  model: 'claude-haiku-4-5-20251001',
  systemPrompt: 'You triage GitHub notification emails into a tight, skimmable Slack digest.',
  harnessSettings: { reasoning: 'low', timeoutSeconds: 300 },

  memory: { enabled: true, scopes: ['workspace'], ttlDays: 30 },

  onEvent: './agent.ts'
});
