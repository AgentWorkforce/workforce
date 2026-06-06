import test from 'node:test';
import assert from 'node:assert/strict';

import type { PersonaSelection, PersonaSpec } from '@agentworkforce/persona-kit';
import {
  buildLaunchMetadata,
  canonicalJson,
  launchMetadataIngestHarness,
  personaVersionHash,
  shouldRecordLaunchMetadata,
  startLaunchMetadataRecording,
  type LaunchMetadataIngestOptions,
  type LaunchMetadataPendingStampOptions
} from './launch-metadata.js';

function fakeSelection(): Pick<PersonaSelection, 'personaId' | 'harness'> {
  return {
    personaId: 'code-reviewer',
    harness: 'codex'
  };
}

function fakeSpec(overrides: Partial<PersonaSpec> = {}): PersonaSpec {
  return {
    id: 'code-reviewer',
    intent: 'review',
    tags: ['review'],
    description: 'Reviews code.',
    skills: [],
    harness: 'codex',
    model: 'openai-codex/gpt-5.3-codex',
    systemPrompt: 'Review the diff.',
    harnessSettings: { reasoning: 'high', timeoutSeconds: 1200 },
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

test('buildLaunchMetadata emits the required AgentWorkforce metadata', () => {
  const spec = fakeSpec();
  const metadata = buildLaunchMetadata({
    selection: fakeSelection(),
    personaSpec: spec,
    personaSource: 'dir:1'
  });

  assert.deepEqual(metadata, {
    agentworkforce: '1',
    persona: 'code-reviewer',
    personaVersion: personaVersionHash(spec),
    personaSource: 'dir:1'
  });
});

test('startLaunchMetadataRecording writes a pending stamp and runs periodic plus final ingest', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const stamps: LaunchMetadataPendingStampOptions[] = [];
  const ingests: LaunchMetadataIngestOptions[] = [];
  const run = await startLaunchMetadataRecording({
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

test('startLaunchMetadataRecording stays quiet on transient ingest failures and warns on a sustained run', async () => {
  const warnings: string[] = [];
  const captureWarn = (msg: string): void => {
    warnings.push(msg);
  };

  // One failing ingest per run (only the final ingest on stop) — below the threshold, no warning.
  const run = await startLaunchMetadataRecording({
    selection: fakeSelection(),
    personaSpec: fakeSpec(),
    personaSource: 'cwd',
    cwd: '/tmp/project',
    intervalMs: 1_000_000,
    onWarn: captureWarn,
    sdk: {
      writePendingStamp: () => {},
      ingest: async () => {
        throw new Error('ingest timed out after 5000ms');
      }
    }
  });
  await run.stop();
  assert.deepEqual(warnings, [], 'a single failure is below the warn threshold');

  // Sustained failures: drive enough ticks for the counter to cross the threshold.
  const run2 = await startLaunchMetadataRecording({
    selection: fakeSelection(),
    personaSpec: fakeSpec(),
    personaSource: 'cwd',
    cwd: '/tmp/project',
    intervalMs: 1,
    onWarn: captureWarn,
    sdk: {
      writePendingStamp: () => {},
      ingest: async () => {
        throw new Error('ingest timed out after 5000ms');
      }
    }
  });
  await new Promise((r) => setTimeout(r, 50));
  await run2.stop();
  assert.equal(warnings.length, 1, 'sustained failures surface exactly one warning');
  assert.match(warnings[0]!, /launch metadata ingest failed: ingest timed out after 5000ms/);

  // Successful ingests stay quiet.
  warnings.length = 0;
  const run3 = await startLaunchMetadataRecording({
    selection: fakeSelection(),
    personaSpec: fakeSpec(),
    personaSource: 'cwd',
    cwd: '/tmp/project',
    intervalMs: 1_000_000,
    onWarn: captureWarn,
    sdk: {
      writePendingStamp: () => {},
      ingest: async () => {}
    }
  });
  await run3.stop();
  assert.deepEqual(warnings, []);
});

test('startLaunchMetadataRecording skips SDK loading and ingest when opted out', async () => {
  let loads = 0;
  const run = await startLaunchMetadataRecording({
    selection: fakeSelection(),
    personaSpec: fakeSpec(),
    personaSource: 'library',
    cwd: '/tmp/project',
    noLaunchMetadata: true,
    sdk: async () => {
      loads += 1;
      throw new Error('should not load');
    }
  });

  await run.stop();
  assert.equal(run.enabled, false);
  assert.equal(loads, 0);
  assert.equal(
    shouldRecordLaunchMetadata({ env: { AGENTWORKFORCE_LAUNCH_METADATA: '0' } }),
    false
  );

  const originalEnvValue = process.env.AGENTWORKFORCE_LAUNCH_METADATA;
  try {
    process.env.AGENTWORKFORCE_LAUNCH_METADATA = '0';
    assert.equal(shouldRecordLaunchMetadata({}), false);
  } finally {
    if (originalEnvValue === undefined) {
      delete process.env.AGENTWORKFORCE_LAUNCH_METADATA;
    } else {
      process.env.AGENTWORKFORCE_LAUNCH_METADATA = originalEnvValue;
    }
  }
});

test('launchMetadataIngestHarness maps AgentWorkforce claude to backend claude-code', () => {
  assert.equal(launchMetadataIngestHarness('claude'), 'claude-code');
  assert.equal(launchMetadataIngestHarness('codex'), 'codex');
  assert.equal(launchMetadataIngestHarness('opencode'), 'opencode');
  assert.equal(launchMetadataIngestHarness('grok'), 'grok');
});
