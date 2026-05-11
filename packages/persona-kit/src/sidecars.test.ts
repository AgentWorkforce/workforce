import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePersonaSidecars } from './sidecars.js';
import { buildPersonaSpawnPlan, type ResolvedPersona } from './plan.js';

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function withTmpDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'persona-kit-sidecars-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

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

test('writePersonaSidecars: extend mode preserves the original on dispose', async () => {
  await withTmpDir(async (dir) => {
    const target = join(dir, 'CLAUDE.md');
    await writeFile(target, 'pre-existing', 'utf8');
    const handle = await writePersonaSidecars(
      [{ filename: 'CLAUDE.md', contents: 'persona body', mode: 'extend' }],
      { cwd: dir }
    );
    assert.equal(await readFile(target, 'utf8'), 'pre-existing\n\n---\n\npersona body');
    await handle.dispose();
    assert.equal(await readFile(target, 'utf8'), 'pre-existing');
  });
});

test('writePersonaSidecars: overwrite of an existing file restores prior contents on dispose', async () => {
  await withTmpDir(async (dir) => {
    const target = join(dir, 'CLAUDE.md');
    await writeFile(target, 'original', 'utf8');
    const handle = await writePersonaSidecars(
      [{ filename: 'CLAUDE.md', contents: 'replacement', mode: 'overwrite' }],
      { cwd: dir }
    );
    assert.equal(await readFile(target, 'utf8'), 'replacement');
    await handle.dispose();
    assert.equal(await readFile(target, 'utf8'), 'original');
  });
});

test('writePersonaSidecars: extend mode against an empty cwd writes the persona body verbatim', async () => {
  // No prior file → "extend" still writes; on dispose the file is removed.
  await withTmpDir(async (dir) => {
    const handle = await writePersonaSidecars(
      [{ filename: 'AGENTS.md', contents: 'persona body', mode: 'extend' }],
      { cwd: dir }
    );
    const target = join(dir, 'AGENTS.md');
    assert.equal(await readFile(target, 'utf8'), 'persona body');
    await handle.dispose();
    assert.equal(await exists(target), false);
  });
});

test('writePersonaSidecars: rejects sourcePath that is not absolute', async () => {
  await withTmpDir(async (dir) => {
    await assert.rejects(
      writePersonaSidecars(
        [{ filename: 'CLAUDE.md', sourcePath: 'relative/source.md', mode: 'overwrite' }],
        { cwd: dir }
      ),
      /sourcePath must be absolute/
    );
  });
});

test('writePersonaSidecars: dispose runs in LIFO order (later sidecar restored before earlier)', async () => {
  await withTmpDir(async (dir) => {
    // Two sidecars touched in order [CLAUDE, AGENTS]; both originally absent.
    // After dispose neither should exist.
    const handle = await writePersonaSidecars(
      [
        { filename: 'CLAUDE.md', contents: 'first', mode: 'overwrite' },
        { filename: 'AGENTS.md', contents: 'second', mode: 'overwrite' }
      ],
      { cwd: dir }
    );
    assert.equal(await exists(join(dir, 'CLAUDE.md')), true);
    assert.equal(await exists(join(dir, 'AGENTS.md')), true);
    await handle.dispose();
    assert.equal(await exists(join(dir, 'CLAUDE.md')), false);
    assert.equal(await exists(join(dir, 'AGENTS.md')), false);
  });
});

test('buildPersonaSpawnPlan + writePersonaSidecars round-trip a path-backed sidecar', async () => {
  await withTmpDir(async (dir) => {
    const sourcePath = join(dir, 'persona-source.md');
    await writeFile(sourcePath, '# from disk', 'utf8');
    const plan = buildPersonaSpawnPlan(
      persona({ claudeMd: sourcePath, claudeMdMode: 'overwrite' }),
      { processEnv: cleanEnv }
    );
    assert.equal(plan.sidecars[0]?.sourcePath, sourcePath);
    const handle = await writePersonaSidecars(plan.sidecars, { cwd: dir });
    assert.equal(await readFile(join(dir, 'CLAUDE.md'), 'utf8'), '# from disk');
    await handle.dispose();
    assert.equal(await exists(join(dir, 'CLAUDE.md')), false);
  });
});
