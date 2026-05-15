import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  computeSkillCacheFingerprint,
  isSkillCacheValid,
  readSkillCacheMarker,
  resolveSkillCacheDir,
  skillCacheRoot,
  writeSkillCacheMarker
} from './skill-cache.js';
import type { PersonaSkill } from './types.js';

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'persona-kit-skill-cache-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const remoteSkill: PersonaSkill = {
  id: 'choosing-swarm-patterns',
  source: '@agent-relay/choosing-swarm-patterns',
  description: 'remote'
};
const remoteSkill2: PersonaSkill = {
  id: 'writing-workflows',
  source: '@agent-relay/writing-agent-relay-workflows',
  description: 'remote-2'
};

test('computeSkillCacheFingerprint: deterministic for the same input', () => {
  const a = computeSkillCacheFingerprint({
    harness: 'claude',
    skills: [remoteSkill, remoteSkill2]
  });
  const b = computeSkillCacheFingerprint({
    harness: 'claude',
    skills: [remoteSkill, remoteSkill2]
  });
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{32}$/);
});

test('computeSkillCacheFingerprint: order-independent over skills', () => {
  const a = computeSkillCacheFingerprint({
    harness: 'claude',
    skills: [remoteSkill, remoteSkill2]
  });
  const b = computeSkillCacheFingerprint({
    harness: 'claude',
    skills: [remoteSkill2, remoteSkill]
  });
  assert.equal(a, b);
});

test('computeSkillCacheFingerprint: harness change invalidates', () => {
  const a = computeSkillCacheFingerprint({
    harness: 'claude',
    skills: [remoteSkill]
  });
  const b = computeSkillCacheFingerprint({
    harness: 'opencode',
    skills: [remoteSkill]
  });
  assert.notEqual(a, b);
});

test('computeSkillCacheFingerprint: source change invalidates', () => {
  const a = computeSkillCacheFingerprint({
    harness: 'claude',
    skills: [{ ...remoteSkill, source: '@scope/v1' }]
  });
  const b = computeSkillCacheFingerprint({
    harness: 'claude',
    skills: [{ ...remoteSkill, source: '@scope/v2' }]
  });
  assert.notEqual(a, b);
});

test('computeSkillCacheFingerprint: description change does NOT invalidate', () => {
  // description is documentation metadata, not a behavioral input — flipping it
  // should not force a fresh install.
  const a = computeSkillCacheFingerprint({
    harness: 'claude',
    skills: [{ ...remoteSkill, description: 'one' }]
  });
  const b = computeSkillCacheFingerprint({
    harness: 'claude',
    skills: [{ ...remoteSkill, description: 'two' }]
  });
  assert.equal(a, b);
});

test('computeSkillCacheFingerprint: local skill content changes invalidate', async () => {
  await withTmpDir(async (dir) => {
    const skillPath = 'skills/foo.md';
    await writeFile(join(dir, 'skills', 'foo.md').replace('foo.md', ''), '', 'utf8').catch(
      () => undefined
    );
    // Ensure the dir exists, then write content.
    await import('node:fs/promises').then((fs) =>
      fs.mkdir(join(dir, 'skills'), { recursive: true })
    );
    await writeFile(join(dir, skillPath), '# original', 'utf8');
    const before = computeSkillCacheFingerprint({
      harness: 'claude',
      skills: [{ id: 'foo', source: `./${skillPath}`, description: 'local' }],
      repoRoot: dir
    });
    await writeFile(join(dir, skillPath), '# edited', 'utf8');
    const after = computeSkillCacheFingerprint({
      harness: 'claude',
      skills: [{ id: 'foo', source: `./${skillPath}`, description: 'local' }],
      repoRoot: dir
    });
    assert.notEqual(before, after);
  });
});

test('computeSkillCacheFingerprint: missing local file does not throw', () => {
  const fp = computeSkillCacheFingerprint({
    harness: 'claude',
    skills: [
      { id: 'gone', source: './no/such/file.md', description: 'missing' }
    ],
    repoRoot: '/nonexistent'
  });
  assert.match(fp, /^[0-9a-f]{32}$/);
});

test('skillCacheRoot / resolveSkillCacheDir: under ~/.agentworkforce/workforce/cache/plugins', () => {
  const root = skillCacheRoot();
  assert.match(root, /\.agentworkforce[\\/]workforce[\\/]cache[\\/]plugins$/);
  const fp = 'a'.repeat(32);
  assert.equal(resolveSkillCacheDir(fp), join(root, fp));
});

test('writeSkillCacheMarker / readSkillCacheMarker round-trips', async () => {
  await withTmpDir(async (dir) => {
    writeSkillCacheMarker(dir, {
      fingerprint: 'abc123',
      harness: 'claude',
      skills: [{ id: 'foo', source: 'x/y' }]
    });
    const read = readSkillCacheMarker(dir);
    assert.ok(read);
    assert.equal(read.schemaVersion, 1);
    assert.equal(read.fingerprint, 'abc123');
    assert.equal(read.harness, 'claude');
    assert.equal(read.skills.length, 1);
    assert.equal(read.skills[0]?.source, 'x/y');
    assert.match(read.installedAt, /\d{4}-\d{2}-\d{2}T/);
  });
});

test('readSkillCacheMarker: returns null for missing/malformed marker', async () => {
  await withTmpDir(async (dir) => {
    assert.equal(readSkillCacheMarker(dir), null);
    await writeFile(join(dir, '.aw-skill-cache.json'), '{not json', 'utf8');
    assert.equal(readSkillCacheMarker(dir), null);
  });
});

test('readSkillCacheMarker: returns null for unknown schema version', async () => {
  await withTmpDir(async (dir) => {
    await writeFile(
      join(dir, '.aw-skill-cache.json'),
      JSON.stringify({
        schemaVersion: 99,
        fingerprint: 'x',
        harness: 'claude',
        installedAt: '2026-01-01T00:00:00Z',
        skills: []
      }),
      'utf8'
    );
    assert.equal(readSkillCacheMarker(dir), null);
  });
});

test('isSkillCacheValid: requires fingerprint match', async () => {
  await withTmpDir(async (dir) => {
    writeSkillCacheMarker(dir, {
      fingerprint: 'fp-real',
      harness: 'claude',
      skills: []
    });
    assert.equal(isSkillCacheValid(dir, 'fp-real'), true);
    assert.equal(isSkillCacheValid(dir, 'fp-different'), false);
  });
});
