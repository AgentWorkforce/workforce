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

export default definePersona({
  id: 'github-email-digest',
  intent: 'relay-orchestrator',
  tags: ['proactive', 'email', 'triage', 'digest'],
  description:
    'Proactive agent: 3×/day, summarizes new GitHub emails from your Gmail inbox, DMs you the digest on Slack, and archives only the messages you approve (by labelling them).',
  cloud: true,

  // `gmail` mounts the Relayfile VFS at /gmail so the handler can read inbox
  // messages and issue the archive writeback. `slack` gives the handler the
  // typed ctx.slack client for the DM. No triggers here — this persona is
  // schedule-driven (see below). If you typed a `triggers` block under gmail,
  // your editor would now autocomplete file.created / file.updated /
  // file.deleted thanks to PR #113.
  integrations: {
    gmail: {},
    slack: {}
  },

  // Three times a day. cron is "minute hour … " — 08:00, 13:00, 18:00.
  // Change `tz` to your timezone (IANA name); it defaults to UTC otherwise.
  schedules: [{ name: 'digest', cron: '0 8,13,18 * * *', tz: 'America/New_York' }],

  inputs: {
    SLACK_USER: {
      description: 'Your Slack user id (e.g. U0123ABCD) — the agent DMs you here.',
      env: 'SLACK_USER'
    },
    GMAIL_ACCOUNT: {
      description: 'Gmail account segment in the VFS path /gmail/<account>/threads.',
      env: 'GMAIL_ACCOUNT',
      default: 'me'
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
