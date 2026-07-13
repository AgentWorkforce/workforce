import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  launchPlanKey,
  launchPlanPath,
  statDigestOf,
  tryFastAgentLaunch,
  warmMountDir,
  writeLaunchPlan,
  deleteLaunchPlan,
  LAUNCH_PLAN_SCHEMA_VERSION,
  type LaunchPlan
} from './fast-launch.js';

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aw-fast-launch-test-'));
}

test('launchPlanKey: stable per (cwd, selector), distinct across either', () => {
  const a = launchPlanKey('/repo/one', 'persona-maker');
  assert.equal(a, launchPlanKey('/repo/one', 'persona-maker'));
  assert.notEqual(a, launchPlanKey('/repo/two', 'persona-maker'));
  assert.notEqual(a, launchPlanKey('/repo/one', 'other-persona'));
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('launchPlanPath and warmMountDir share the plan key', () => {
  const key = launchPlanKey('/repo/one', 'persona-maker');
  assert.ok(launchPlanPath('/repo/one', 'persona-maker').includes(key));
  assert.ok(warmMountDir('/repo/one', 'persona-maker').endsWith(key));
});

test('statDigestOf: existing file captures size+mtime, missing file is all-null', () => {
  const dir = tempDir();
  try {
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'hello');
    const digest = statDigestOf(file);
    const st = statSync(file);
    assert.equal(digest.size, st.size);
    assert.equal(digest.mtimeMs, st.mtimeMs);

    const missing = statDigestOf(join(dir, 'nope.txt'));
    assert.equal(missing.size, null);
    assert.equal(missing.mtimeMs, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tryFastAgentLaunch: refuses flags, multiple args, and missing plans', () => {
  assert.equal(tryFastAgentLaunch([]), null);
  assert.equal(tryFastAgentLaunch(['--dry-run']), null);
  assert.equal(tryFastAgentLaunch(['persona-maker', 'extra']), null);
  // No plan exists for this selector in this cwd.
  assert.equal(tryFastAgentLaunch(['no-such-persona-for-fast-launch-test']), null);
});

function planFixture(overrides: Partial<LaunchPlan> = {}): LaunchPlan {
  const cwd = process.cwd();
  return {
    schemaVersion: LAUNCH_PLAN_SCHEMA_VERSION,
    cliVersion: 'not-the-real-version',
    cwd,
    selector: 'fast-launch-test-persona',
    personaId: 'fast-launch-test-persona',
    harness: 'opencode',
    model: 'opencode/test',
    digests: [],
    envExact: {},
    skillCache: {
      dir: '/nonexistent',
      fingerprint: 'f'.repeat(32),
      upstreamIntervalRaw: null,
      upstreamIntervalMs: null
    },
    spawn: { binPath: '/nonexistent/bin', args: [], envAdditions: {} },
    mount: { warmDir: '/nonexistent', ignoredPatterns: [], readonlyPatterns: [] },
    ...overrides
  };
}

test('tryFastAgentLaunch: version, env pin, and digest mismatches all fall back', () => {
  const selector = 'fast-launch-test-persona';
  try {
    // Wrong CLI version → refused before anything else is touched.
    writeLaunchPlan(planFixture());
    assert.equal(tryFastAgentLaunch([selector]), null);

    // Note: a plan with the real CLI version would next fail on env pins /
    // digests; exercise the env pin gate explicitly.
    const pkg = statDigestOf(new URL('../package.json', import.meta.url).pathname);
    assert.ok(pkg.size !== null, 'test sanity: package.json digest');
    writeLaunchPlan(
      planFixture({
        cliVersion: (JSON.parse(
          readFileSync(new URL('../package.json', import.meta.url), 'utf8')
        ) as { version: string }).version,
        envExact: { AW_FAST_LAUNCH_TEST_PIN: 'expected-value' }
      })
    );
    assert.equal(process.env.AW_FAST_LAUNCH_TEST_PIN, undefined);
    assert.equal(tryFastAgentLaunch([selector]), null);
  } finally {
    deleteLaunchPlan(process.cwd(), selector);
  }
});

test('writeLaunchPlan/deleteLaunchPlan round trip', () => {
  const selector = 'fast-launch-roundtrip-persona';
  const plan = planFixture({ selector, personaId: selector });
  try {
    writeLaunchPlan(plan);
    const onDisk = JSON.parse(
      readFileSync(launchPlanPath(process.cwd(), selector), 'utf8')
    ) as LaunchPlan;
    assert.equal(onDisk.selector, selector);
    assert.equal(onDisk.schemaVersion, LAUNCH_PLAN_SCHEMA_VERSION);
  } finally {
    deleteLaunchPlan(process.cwd(), selector);
  }
  assert.equal(tryFastAgentLaunch([selector]), null);
});

test('tryFastAgentLaunch: valid-looking plan still refuses without a warm mount', () => {
  const selector = 'fast-launch-no-warm-mount-persona';
  const dir = tempDir();
  try {
    const bin = join(dir, 'bin.sh');
    writeFileSync(bin, '#!/bin/sh\nexit 0\n');
    const cacheDir = join(dir, 'skill-cache');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      join(cacheDir, '.aw-skill-cache.json'),
      JSON.stringify({
        fingerprint: 'f'.repeat(32),
        lastUpstreamCheckAt: new Date().toISOString()
      })
    );
    const version = (JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version: string }).version;
    writeLaunchPlan(
      planFixture({
        selector,
        personaId: selector,
        cliVersion: version,
        skillCache: {
          dir: cacheDir,
          fingerprint: 'f'.repeat(32),
          upstreamIntervalRaw: null,
          // Interval null = drift checks disabled → marker age irrelevant.
          upstreamIntervalMs: null
        },
        spawn: { binPath: bin, args: [], envAdditions: {} },
        mount: { warmDir: join(dir, 'warm'), ignoredPatterns: [], readonlyPatterns: [] }
      })
    );
    // Everything validates except the warm mount (missing marker/state).
    assert.equal(tryFastAgentLaunch([selector]), null);
  } finally {
    deleteLaunchPlan(process.cwd(), selector);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tryFastAgentLaunch: corrupted or truncated plans fall back instead of throwing', () => {
  const selector = 'fast-launch-corrupt-plan-persona';
  const planPath = launchPlanPath(process.cwd(), selector);
  const version = (JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8')
  ) as { version: string }).version;
  try {
    mkdirSync(join(planPath, '..'), { recursive: true });
    // Not JSON at all.
    writeFileSync(planPath, '{not json');
    assert.equal(tryFastAgentLaunch([selector]), null);
    // Valid JSON, right version/selector, but missing whole sections.
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: LAUNCH_PLAN_SCHEMA_VERSION,
        cliVersion: version,
        cwd: process.cwd(),
        selector
      })
    );
    assert.equal(tryFastAgentLaunch([selector]), null);
    // Sections present but null.
    writeFileSync(
      planPath,
      JSON.stringify({
        schemaVersion: LAUNCH_PLAN_SCHEMA_VERSION,
        cliVersion: version,
        cwd: process.cwd(),
        selector,
        digests: null,
        envExact: null,
        skillCache: null,
        spawn: null,
        mount: null
      })
    );
    assert.equal(tryFastAgentLaunch([selector]), null);
  } finally {
    deleteLaunchPlan(process.cwd(), selector);
  }
});

test('statDigestOf: directories digest with size pinned to 0', () => {
  const dir = tempDir();
  try {
    writeFileSync(join(dir, 'entry.txt'), 'content');
    const digest = statDigestOf(dir);
    assert.equal(digest.size, 0);
    assert.notEqual(digest.mtimeMs, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
