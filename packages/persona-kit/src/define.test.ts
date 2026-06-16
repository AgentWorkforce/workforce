import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_SCOPE_KEY_CATALOG,
  definePersona,
  parsePersonaSpec,
  type GitHubMaterializationPolicy,
  type ScopeKeysFor,
  type TypedScopeMap,
  type TypedTriggerMap
} from './index.js';

test('definePersona returns authored specs that parse successfully', () => {
  const persona = definePersona({
    id: 'typed-author',
    intent: 'review',
    description: 'Typed authoring fixture.',
    inputs: {
      TOPIC: 'pull requests',
      TARGET_REPO: {
        description: 'Repository to inspect.',
        default: 'AgentWorkforce/workforce'
      }
    },
    // Personas declare integration *connections* only — event triggers moved
    // to the agent (defineAgent). Connection config = source + scope + adapter config.
    integrations: {
      github: {
        scope: { repo: 'AgentWorkforce/workforce' },
        config: {
          materialization: {
            default: 'lazy',
            webhookWritesForLazyRepos: true,
            rules: [
              {
                repos: ['AgentWorkforce/workforce'],
                resources: ['issues', 'pulls'],
                issues: { mode: 'eager', filter: { state: 'open', labels: ['bug'] } },
                pulls: 'eager'
              }
            ]
          }
        }
      },
      linear: {},
      slack: {},
      confluence: {},
      jira: {},
      customProvider: {}
    },
    capabilities: {
      review: true,
      conflictAutofix: { enabled: false }
    },
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
  });

  const parsed = parsePersonaSpec(persona, 'review');

  assert.equal(parsed.id, 'typed-author');
  assert.equal(parsed.skills.length, 0);
  assert.equal(parsed.inputs?.TOPIC.default, 'pull requests');
  assert.equal(parsed.integrations?.github.scope?.repo, 'AgentWorkforce/workforce');
  assert.deepEqual(parsed.integrations?.github.config?.materialization, {
    default: 'lazy',
    webhookWritesForLazyRepos: true,
    rules: [
      {
        repos: ['AgentWorkforce/workforce'],
        resources: ['issues', 'pulls'],
        issues: { mode: 'eager', filter: { state: 'open', labels: ['bug'] } },
        pulls: 'eager'
      }
    ]
  });
  assert.equal(parsed.integrations?.customProvider.source?.kind, 'deployer_user');
  assert.deepEqual(parsed.capabilities, {
    review: true,
    conflictAutofix: { enabled: false }
  });
});

test('TypedTriggerMap gives per-provider event autocomplete; arbitrary providers fall back to string', () => {
  // Known providers type `on` against their catalog (off-registry strings are
  // still allowed via `string & {}`); unknown providers accept any string.
  const triggers: TypedTriggerMap = {
    github: [
      { on: 'pull_request.opened' },
      { on: 'off_registry.github_event' }
    ],
    linear: [
      { on: 'issue.create' },
      { on: 'AgentSessionEvent.created' },
      { on: 'AgentSessionEvent.prompted' },
      { on: 'AppUserNotification.issueCommentMention' }
    ],
    slack: [{ on: 'message.created', maxConcurrency: 1 }],
    customProvider: [{ on: 'custom.event' }]
  };
  assert.equal(triggers.github?.[1]?.on, 'off_registry.github_event');
  assert.equal(triggers.slack?.[0]?.maxConcurrency, 1);
  assert.equal(triggers.customProvider?.[0]?.on, 'custom.event');
});

test('definePersona types github materialization config but keeps unknown provider config generic', () => {
  const materialization: GitHubMaterializationPolicy = {
    default: 'lazy',
    rules: [
      {
        repos: ['AgentWorkforce/workforce'],
        eager: true,
        issues: { mode: 'eager', since: '2026-01-01T00:00:00.000Z' },
        pulls: { mode: 'lazy', filter: { state: 'all' } }
      }
    ]
  };

  const persona = definePersona({
    id: 'adapter-config-author',
    intent: 'review',
    description: 'Adapter config typing fixture.',
    integrations: {
      github: {
        scope: { repo: 'AgentWorkforce/workforce' },
        config: { materialization }
      },
      customProvider: {
        config: { anyFutureAdapterField: { stays: true } }
      }
    },
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 60 }
  });

  const issuesPolicy = persona.integrations?.github?.config?.materialization?.rules?.[0]?.issues;
  assert.equal(
    issuesPolicy && typeof issuesPolicy === 'object' ? issuesPolicy.mode : undefined,
    'eager'
  );
  assert.deepEqual(persona.integrations?.customProvider?.config, {
    anyFutureAdapterField: { stays: true }
  });

  definePersona({
    id: 'bad-github-materialization-mode',
    intent: 'review',
    description: 'GitHub materialization aliases are adapter-runtime inputs, not typed authoring.',
    integrations: {
      github: {
        config: {
          materialization: {
            // @ts-expect-error persona-kit authoring exposes canonical lazy/eager modes
            default: 'all'
          }
        }
      }
    },
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 60 }
  });
});

test('TypedScopeMap gives per-provider scope key autocomplete while allowing future keys', () => {
  const githubScope: TypedScopeMap<'github'> = {
    owner: 'AgentWorkforce',
    repo: 'workforce',
    installation: 'future-runtime-key'
  };
  const customScope: TypedScopeMap<'customProvider'> = {
    anyKey: 'any-value'
  };

  const githubKey: ScopeKeysFor<'github'> = 'repo';
  // @ts-expect-error github has no catalogued "channel" scope key
  const badGithubKey: ScopeKeysFor<'github'> = 'channel';

  // Providers with no catalogued scope keys (slack today) still accept
  // arbitrary keys via TypedScopeMap's index signature — no typing regression.
  const slackScope: TypedScopeMap<'slack'> = { channel: 'C123' };

  assert.equal(githubScope[githubKey], 'workforce');
  assert.deepEqual([...KNOWN_SCOPE_KEY_CATALOG.github], ['owner', 'repo']);
  assert.equal(customScope.anyKey, 'any-value');
  assert.equal(slackScope.channel, 'C123');
  assert.equal(badGithubKey, 'channel');
});

test('definePersona types tags against the closed PersonaTag vocabulary', () => {
  const persona = definePersona({
    id: 'tagged',
    intent: 'review',
    description: 'Tag typing fixture.',
    tags: ['documentation', 'review'],
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 60 }
  });
  assert.deepEqual([...(persona.tags ?? [])], ['documentation', 'review']);

  definePersona({
    id: 'bad-tag',
    intent: 'review',
    description: 'An off-vocabulary tag must be a compile error, not a deploy-time 400.',
    // @ts-expect-error 'proactive' is not a PersonaTag (cloud rejects it with 400 invalid_persona)
    tags: ['proactive'],
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 60 }
  });
});

test('definePersona type allows interactive personas without onEvent', () => {
  const persona = definePersona({
    id: 'interactive-author',
    intent: 'documentation',
    description: 'Interactive authoring fixture.',
    harness: 'codex',
    model: 'gpt-5.4',
    systemPrompt: 'Write accurate docs.',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 120 }
  });

  assert.equal(persona.harness, 'codex');
});
