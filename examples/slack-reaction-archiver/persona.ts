/**
 * A REAL persona that subscribes to a Slack trigger.
 *
 * The `on: 'reaction.added'` below is where PR #113's autocomplete actually
 * earns its keep: because this is a typed `persona.ts` and `slack` is in
 * `KNOWN_TRIGGER_CATALOG`, your editor suggests slack's real events as you type
 * `on: '` — channel.created | message.created | reaction.added | reaction.removed
 * | user.joined | … — and `agentworkforce deploy` lints the value against the
 * same catalog, so a typo like 'reaction.add' is caught before it ships.
 *
 * Compile: agentworkforce persona compile ./persona.ts   (CLI/persona-kit ≥ 3.0.23)
 */
import { definePersona } from '@agentworkforce/persona-kit';

export default definePersona({
  id: 'slack-reaction-archiver',
  intent: 'relay-orchestrator',
  tags: ['proactive', 'slack', 'email', 'archive'],
  description:
    'React with ✅ to a GitHub-email digest in Slack and this agent archives those Gmail messages — the Slack-native approval gate for github-email-digest.',
  cloud: true,
  useSubscription: true,

  integrations: {
    // ── Slack triggers — `triggers` is an array, so list as many as you want.
    //    Each `on` autocompletes independently (and each entry may add optional
    //    `match` / `where` filters). Here: ✅ archives, removing the ✅ undoes it.
    slack: {
      triggers: [
        { on: 'reaction.added' },
        { on: 'reaction.removed' }
        // e.g. you could also narrow with a filter:
        // { on: 'message.created', where: "channel == 'C_GITHUB_ALERTS'" }
      ]
    },
    // Gmail VFS for the archive writeback. The provider id is `google-mail`
    // (mounted at /google-mail) — NOT `gmail` (that's just the adapter slug;
    // deploying with `gmail` fails connect with 409 unknown_provider).
    'google-mail': {}
  },

  inputs: {
    EMOJI: {
      description: 'Emoji whose reaction approves archiving (no colons).',
      env: 'EMOJI',
      default: 'white_check_mark'
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
    DRY_RUN: {
      description: 'Set "true" to detect + reply but never write the archive.',
      env: 'DRY_RUN',
      default: 'false'
    }
  },

  memory: { enabled: false },

  // No harness/model/systemPrompt: this is a pure handler (no LLM call).
  // harnessSettings is still required by the persona schema — keep it minimal.
  harnessSettings: { reasoning: 'low', timeoutSeconds: 120 },

  onEvent: './agent.ts'
});
