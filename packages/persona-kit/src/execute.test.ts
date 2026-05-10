import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildPersonaSpawnPlan, type ResolvedPersona } from './plan.js';
import { executePersonaSpawnPlan } from './execute.js';
import { writePersonaSidecars } from './sidecars.js';
import { materializePersonaConfigFiles } from './config-files.js';
import { runSkillInstalls, SkillInstallError } from './skill-runner.js';
import type { SkillMaterializationPlan } from './types.js';

const cleanEnv: NodeJS.ProcessEnv = Object.freeze({}) as NodeJS.ProcessEnv;

function persona(over: Partial<ResolvedPersona> = {}): ResolvedPersona {
  return {
    personaId: 'p',
    tier: 'best-value',
    runtime: {
      harness: 'claude',
      model: 'anthropic/claude-3-5-sonnet',
      systemPrompt: 'be helpful',
      harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
    },
    skills: [],
    rationale: 'test',
    ...over
  };
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'persona-kit-test-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('writePersonaSidecars overwrite + dispose restores empty target', async () => {
  await withTmpDir(async (dir) => {
    const handle = await writePersonaSidecars(
      [{ filename: 'CLAUDE.md', contents: 'persona body', mode: 'overwrite' }],
      { cwd: dir }
    );
    const target = join(dir, 'CLAUDE.md');
    assert.equal(await readFile(target, 'utf8'), 'persona body');
    await handle.dispose();
    assert.equal(await exists(target), false);
    // Idempotent
    await handle.dispose();
  });
});

test('writePersonaSidecars resolves sourcePath at write time', async () => {
  await withTmpDir(async (dir) => {
    const sourcePath = join(dir, 'source.md');
    await writeFile(sourcePath, 'persona body from disk', 'utf8');
    const handle = await writePersonaSidecars(
      [{ filename: 'CLAUDE.md', sourcePath, mode: 'overwrite' }],
      { cwd: dir }
    );
    assert.equal(
      await readFile(join(dir, 'CLAUDE.md'), 'utf8'),
      'persona body from disk'
    );
    await handle.dispose();
  });
});

test('writePersonaSidecars rejects unsafe filenames', async () => {
  await withTmpDir(async (dir) => {
    await assert.rejects(
      writePersonaSidecars(
        [
          {
            filename: '../escape.md' as 'CLAUDE.md',
            contents: 'x',
            mode: 'overwrite'
          }
        ],
        { cwd: dir }
      ),
      /must be a basename/
    );
    await assert.rejects(
      writePersonaSidecars(
        [
          {
            filename: '/abs.md' as 'CLAUDE.md',
            contents: 'x',
            mode: 'overwrite'
          }
        ],
        { cwd: dir }
      ),
      /must be relative/
    );
  });
});

test('writePersonaSidecars extend joins existing content with delimiter', async () => {
  await withTmpDir(async (dir) => {
    const target = join(dir, 'AGENTS.md');
    await writeFile(target, 'existing body', 'utf8');
    const handle = await writePersonaSidecars(
      [{ filename: 'AGENTS.md', contents: 'persona body', mode: 'extend' }],
      { cwd: dir }
    );
    assert.equal(
      await readFile(target, 'utf8'),
      'existing body\n\n---\n\npersona body'
    );
    await handle.dispose();
    assert.equal(await readFile(target, 'utf8'), 'existing body');
  });
});

test('materializePersonaConfigFiles writes nested paths and restores them', async () => {
  await withTmpDir(async (dir) => {
    const handle = await materializePersonaConfigFiles(
      [{ path: '.opencode/agents.json', contents: '{}' }],
      { cwd: dir }
    );
    assert.equal(await readFile(join(dir, '.opencode/agents.json'), 'utf8'), '{}');
    await handle.dispose();
    assert.equal(await exists(join(dir, '.opencode/agents.json')), false);
  });
});

test('materializePersonaConfigFiles rejects unsafe paths before writing', async () => {
  await withTmpDir(async (dir) => {
    await assert.rejects(
      materializePersonaConfigFiles([{ path: '../escape', contents: 'x' }], { cwd: dir }),
      /must not contain ".." segments/
    );
    await assert.rejects(
      materializePersonaConfigFiles([{ path: '/abs', contents: 'x' }], { cwd: dir }),
      /must be relative/
    );
  });
});

test('runSkillInstalls rejects cleanup paths that escape cwd', async () => {
  await withTmpDir(async (dir) => {
    const plan: SkillMaterializationPlan = {
      harness: 'claude',
      installs: [
        {
          skillId: 's',
          source: 'x/y',
          sourceKind: 'prpm',
          packageRef: 'x/y',
          harness: 'claude',
          installCommand: ['true'],
          installedDir: '.claude/skills/y',
          installedManifest: '.claude/skills/y/SKILL.md',
          cleanupPaths: ['../escape']
        }
      ]
    };
    const handle = await runSkillInstalls(plan, { cwd: dir });
    await assert.rejects(handle.dispose(), /must stay within cwd/);
  });
});

test('runSkillInstalls scaffolds the session install root and disposes it', async () => {
  await withTmpDir(async (dir) => {
    const sessionRoot = join(dir, 'session');
    const plan: SkillMaterializationPlan = {
      harness: 'claude',
      installs: [],
      sessionInstallRoot: sessionRoot
    };
    const handle = await runSkillInstalls(plan, { cwd: dir });
    assert.ok(await exists(join(sessionRoot, '.claude-plugin', 'plugin.json')));
    await handle.dispose();
    assert.equal(await exists(sessionRoot), false);
  });
});

test('runSkillInstalls spawns the chained install command for a non-session plan', async () => {
  await withTmpDir(async (dir) => {
    // Non-session mode runs `install.installCommand` verbatim — use a
    // harmless `true` so the spawn path is exercised without network or
    // disk side effects. cleanupPaths is empty so dispose is a no-op.
    const plan: SkillMaterializationPlan = {
      harness: 'claude',
      installs: [
        {
          skillId: 'noop',
          source: 'noop/noop',
          sourceKind: 'prpm',
          packageRef: 'noop/noop',
          harness: 'claude',
          installCommand: ['sh', '-c', 'true'],
          installedDir: '.claude/skills/noop',
          installedManifest: '.claude/skills/noop/SKILL.md',
          cleanupPaths: []
        }
      ]
    };
    const handle = await runSkillInstalls(plan, { cwd: dir });
    await handle.dispose();
  });
});

test('runSkillInstalls surfaces a non-zero install with SkillInstallError', async () => {
  await withTmpDir(async (dir) => {
    const plan: SkillMaterializationPlan = {
      harness: 'claude',
      installs: [
        {
          skillId: 'fail',
          source: 'fail/fail',
          sourceKind: 'prpm',
          packageRef: 'fail/fail',
          harness: 'claude',
          installCommand: ['sh', '-c', 'exit 17'],
          installedDir: '.claude/skills/fail',
          installedManifest: '.claude/skills/fail/SKILL.md',
          cleanupPaths: []
        }
      ]
    };
    await assert.rejects(runSkillInstalls(plan, { cwd: dir }), (err: Error) => {
      assert.equal(err.name, 'SkillInstallError');
      assert.equal((err as SkillInstallError).exitCode, 17);
      return true;
    });
  });
});

test('executePersonaSpawnPlan happy path orders side effects and disposes them in LIFO', async () => {
  await withTmpDir(async (dir) => {
    const plan = buildPersonaSpawnPlan(
      persona({
        personaId: 'sample',
        runtime: {
          harness: 'opencode',
          model: 'anthropic/claude-3-5-sonnet',
          systemPrompt: 'opencode prompt',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
        },
        agentsMdContent: '# persona agents',
        agentsMdMode: 'overwrite'
      }),
      { processEnv: cleanEnv }
    );
    assert.ok(plan.configFiles.some((f) => f.path.endsWith('opencode.json')));
    assert.equal(plan.sidecars[0]?.filename, 'AGENTS.md');

    const handle = await executePersonaSpawnPlan(plan, { cwd: dir });
    assert.equal(handle.cwd, dir);
    assert.equal(await readFile(join(dir, 'AGENTS.md'), 'utf8'), '# persona agents');
    assert.equal(await exists(join(dir, 'opencode.json')), true);

    await handle.dispose();
    assert.equal(await exists(join(dir, 'AGENTS.md')), false);
    assert.equal(await exists(join(dir, 'opencode.json')), false);
    // Idempotent
    await handle.dispose();
  });
});

test('executePersonaSpawnPlan empty-skills path is a no-op for skills', async () => {
  await withTmpDir(async (dir) => {
    const plan = buildPersonaSpawnPlan(persona(), { processEnv: cleanEnv });
    assert.equal(plan.skills.installs.length, 0);
    const handle = await executePersonaSpawnPlan(plan, { cwd: dir });
    assert.equal(handle.cwd, dir);
    await handle.dispose();
  });
});

test('executePersonaSpawnPlan disposes prior handles when a later step fails', async () => {
  await withTmpDir(async (dir) => {
    // Pre-create a stub at AGENTS.md so we can verify it gets restored after a
    // later failing step. Then synthesize a plan whose configFile path is unsafe
    // — it should reject after the sidecar step has already written to disk.
    const target = join(dir, 'AGENTS.md');
    await writeFile(target, 'previous content', 'utf8');

    const plan = buildPersonaSpawnPlan(
      persona({
        personaId: 'sample',
        runtime: {
          harness: 'opencode',
          model: 'anthropic/claude-3-5-sonnet',
          systemPrompt: 'opencode prompt',
          harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 }
        },
        agentsMdContent: '# persona agents',
        agentsMdMode: 'overwrite'
      }),
      { processEnv: cleanEnv }
    );
    // Inject an unsafe configFile to force materializePersonaConfigFiles to throw
    // after the sidecar has been written. The executor must then restore the
    // sidecar's prior content before the error propagates.
    plan.configFiles.push({ path: '../escape.json', contents: 'x' });

    await assert.rejects(executePersonaSpawnPlan(plan, { cwd: dir }), /must not contain/);
    // Sidecar must be restored to its original content.
    assert.equal(await readFile(target, 'utf8'), 'previous content');
  });
});
