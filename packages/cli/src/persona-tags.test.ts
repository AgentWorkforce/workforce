import test from 'node:test';
import assert from 'node:assert/strict';

import type { PersonaSelection, PersonaSpec } from '@agentworkforce/workload-router';
import {
  buildPersonaTagEnrichment,
  canonicalJson,
  personaTagIngestHarness,
  personaVersionHash,
  shouldRecordPersonaTags,
  startPersonaTagging,
  type PersonaTagIngestOptions,
  type PersonaTagPendingStampOptions
} from './persona-tags.js';

function fakeSelection(): Pick<PersonaSelection, 'personaId' | 'tier' | 'runtime'> {
  return {
    personaId: 'code-reviewer',
    tier: 'best',
    runtime: {
      harness: 'codex',
      model: 'openai-codex/gpt-5.3-codex',
      systemPrompt: 'Review the diff.',
      harnessSettings: {
        reasoning: 'high',
        timeoutSeconds: 1200
      }
    }
  };
}

function fakeSpec(overrides: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    id: 'code-reviewer',
    intent: 'review',
    tags: ['review'],
    description: 'Reviews code.',
    skills: [],
    tiers: {
      best: fakeSelection().runtime,
      'best-value': {
        harness: 'opencode',
        model: 'opencode/gpt-5-nano',
        systemPrompt: 'Review concisely.',
        harnessSettings: {
          reasoning: 'medium',
          timeoutSeconds: 900
        }
      },
      minimum: {
        harness: 'opencode',
        model: 'opencode/minimax-m2.5-free',
        systemPrompt: 'Review blockers.',
        harnessSettings: {
          reasoning: 'low',
          timeoutSeconds: 600
        }
      }
    },
    ...overrides
  };
}

test('personaVersionHash canonicalizes object keys and changes with effective content', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 4, c: 3 } }), '{"a":{"c":3,"d":4},"b":1}');

  const left = {
    id: 'p',
    tiers: {
      best: { model: 'm', harness: 'codex' }
    },
    tags: ['review']
  };
  const right = {
    tags: ['review'],
    tiers: {
      best: { harness: 'codex', model: 'm' }
    },
    id: 'p'
  };
  assert.equal(personaVersionHash(left), personaVersionHash(right));
  assert.notEqual(personaVersionHash(left), personaVersionHash({ ...right, tags: ['testing'] }));
});

test('buildPersonaTagEnrichment emits the required AgentWorkforce tags', () => {
  const spec = fakeSpec();
  const tags = buildPersonaTagEnrichment({
    selection: fakeSelection(),
    personaSpec: spec,
    personaSource: 'dir:1'
  });

  assert.deepEqual(tags, {
    agentworkforce: '1',
    persona: 'code-reviewer',
    personaTier: 'best',
    personaVersion: personaVersionHash(spec),
    personaSource: 'dir:1'
  });
});

test('startPersonaTagging writes a pending stamp and runs periodic plus final ingest', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const stamps: PersonaTagPendingStampOptions[] = [];
  const ingests: PersonaTagIngestOptions[] = [];
  const run = await startPersonaTagging({
    selection: fakeSelection(),
    personaSpec: fakeSpec(),
    personaSource: 'cwd',
    cwd: '/tmp/project',
    intervalMs: 5,
    now: () => new Date('2026-05-08T12:00:00.000Z'),
    sdk: {
      writePendingStamp: (opts) => {
        stamps.push(opts);
      },
      ingest: (opts) => {
        if (opts) ingests.push(opts);
      }
    }
  });

  assert.equal(run.enabled, true);
  t.mock.timers.tick(5);
  await run.stop();

  assert.equal(stamps.length, 1);
  assert.equal(stamps[0]?.harness, 'codex');
  assert.equal(stamps[0]?.cwd, '/tmp/project');
  assert.equal(stamps[0]?.spawnStartTs, '2026-05-08T12:00:00.000Z');
  assert.equal(stamps[0]?.enrichment.persona, 'code-reviewer');
  assert.ok(ingests.length >= 2, 'expected at least one periodic ingest plus final ingest');
  assert.deepEqual(ingests.at(-1), { harness: 'codex' });
});

test('startPersonaTagging skips SDK loading and ingest when opted out', async () => {
  let loads = 0;
  const run = await startPersonaTagging({
    selection: fakeSelection(),
    personaSpec: fakeSpec(),
    personaSource: 'library',
    cwd: '/tmp/project',
    noPersonaTags: true,
    sdk: async () => {
      loads += 1;
      throw new Error('should not load');
    }
  });

  await run.stop();
  assert.equal(run.enabled, false);
  assert.equal(loads, 0);
  assert.equal(
    shouldRecordPersonaTags({ env: { AGENTWORKFORCE_PERSONA_TAGS: '0' } }),
    false
  );

  const originalEnvValue = process.env.AGENTWORKFORCE_PERSONA_TAGS;
  try {
    process.env.AGENTWORKFORCE_PERSONA_TAGS = '0';
    assert.equal(shouldRecordPersonaTags({}), false);
  } finally {
    if (originalEnvValue === undefined) {
      delete process.env.AGENTWORKFORCE_PERSONA_TAGS;
    } else {
      process.env.AGENTWORKFORCE_PERSONA_TAGS = originalEnvValue;
    }
  }
});

test('personaTagIngestHarness maps AgentWorkforce claude to backend claude-code', () => {
  assert.equal(personaTagIngestHarness('claude'), 'claude-code');
  assert.equal(personaTagIngestHarness('codex'), 'codex');
  assert.equal(personaTagIngestHarness('opencode'), 'opencode');
});
