import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runSkillInstalls } from './skill-runner.js';
import type { SkillMaterializationPlan } from './types.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'persona-kit-skills-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('runSkillInstalls: empty plan with no installs and no session root spawns nothing', async () => {
  await withTmpDir(async (dir) => {
    const plan: SkillMaterializationPlan = { harness: 'claude', installs: [] };
    const handle = await runSkillInstalls(plan, { cwd: dir });
    await handle.dispose();
    // Idempotent
    await handle.dispose();
  });
});

test('runSkillInstalls: cleanupOnDispose=false leaves cleanupPaths intact', async () => {
  await withTmpDir(async (dir) => {
    // Pre-create the artifact dir so we can verify it survives dispose.
    const artifactDir = '.claude/skills/persisted';
    await mkdir(join(dir, artifactDir), { recursive: true });
    await writeFile(join(dir, artifactDir, 'SKILL.md'), '# survives', 'utf8');

    const plan: SkillMaterializationPlan = {
      harness: 'claude',
      installs: [
        {
          skillId: 'persisted',
          source: 'persisted/persisted',
          sourceKind: 'prpm',
          packageRef: 'persisted/persisted',
          harness: 'claude',
          // no-op subprocess so the spawn path runs without filesystem effects
          installCommand: [process.execPath, '-e', 'process.exit(0)'],
          installedDir: artifactDir,
          installedManifest: `${artifactDir}/SKILL.md`,
          cleanupPaths: [artifactDir]
        }
      ]
    };
    const handle = await runSkillInstalls(plan, { cwd: dir, cleanupOnDispose: false });
    await handle.dispose();
    assert.equal(await exists(join(dir, artifactDir)), true);
    assert.equal(await readFile(join(dir, artifactDir, 'SKILL.md'), 'utf8'), '# survives');
  });
});

test('runSkillInstalls: cleanupOnDispose=true removes per-install cleanupPaths', async () => {
  await withTmpDir(async (dir) => {
    const artifactDir = '.claude/skills/cleanup-me';
    await mkdir(join(dir, artifactDir), { recursive: true });
    await writeFile(join(dir, artifactDir, 'SKILL.md'), '# transient', 'utf8');

    const plan: SkillMaterializationPlan = {
      harness: 'claude',
      installs: [
        {
          skillId: 'cleanup-me',
          source: 'cleanup-me/cleanup-me',
          sourceKind: 'prpm',
          packageRef: 'cleanup-me/cleanup-me',
          harness: 'claude',
          installCommand: [process.execPath, '-e', 'process.exit(0)'],
          installedDir: artifactDir,
          installedManifest: `${artifactDir}/SKILL.md`,
          cleanupPaths: [artifactDir]
        }
      ]
    };
    const handle = await runSkillInstalls(plan, { cwd: dir });
    await handle.dispose();
    assert.equal(await exists(join(dir, artifactDir)), false);
  });
});

test('runSkillInstalls: session install root scaffolds plugin.json and dispose removes the root', async () => {
  await withTmpDir(async (dir) => {
    const sessionRoot = join(dir, 'session-root');
    const plan: SkillMaterializationPlan = {
      harness: 'claude',
      installs: [],
      sessionInstallRoot: sessionRoot
    };
    const handle = await runSkillInstalls(plan, { cwd: dir });
    assert.equal(await exists(join(sessionRoot, '.claude-plugin', 'plugin.json')), true);
    await handle.dispose();
    assert.equal(await exists(sessionRoot), false);
  });
});

test('runSkillInstalls: session-root cleanupOnDispose=false leaves the root in place', async () => {
  await withTmpDir(async (dir) => {
    const sessionRoot = join(dir, 'sticky-root');
    const plan: SkillMaterializationPlan = {
      harness: 'claude',
      installs: [],
      sessionInstallRoot: sessionRoot
    };
    const handle = await runSkillInstalls(plan, { cwd: dir, cleanupOnDispose: false });
    await handle.dispose();
    assert.equal(await exists(join(sessionRoot, '.claude-plugin', 'plugin.json')), true);
  });
});
