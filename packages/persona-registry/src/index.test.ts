import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import type { PersonaSpec } from '@agentworkforce/persona-kit';
import {
  PersonaResolutionError,
  buildPersonaSourceDirectories,
  findRepoRoot,
  loadLocalPersonas,
  resolvePersonaReference,
  __mergeOverrideForTests
} from './index.js';

test('a later mount layer can re-enable inherited mount patterns', () => {
  const base: PersonaSpec = {
    id: 'base',
    intent: 'review',
    description: 'Base persona',
    skills: [],
    harness: 'codex',
    model: 'openai-codex/test',
    systemPrompt: 'Review',
    harnessSettings: { reasoning: 'medium', timeoutSeconds: 60 },
    mount: {
      ignoredPatterns: ['.env'],
      readonlyPatterns: ['docs/**']
    }
  };
  const disabled = __mergeOverrideForTests(base, {
    id: 'disabled',
    mount: { enabled: false }
  });
  const reenabled = __mergeOverrideForTests(disabled, {
    id: 'reenabled',
    mount: { enabled: true }
  });

  assert.deepEqual(reenabled.mount, {
    enabled: true,
    ignoredPatterns: ['.env'],
    readonlyPatterns: ['docs/**']
  });
});

test('resolves a built-in persona to an interactive selection', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'persona-registry-built-in-'));
  try {
    const resolved = resolvePersonaReference('persona-maker', { cwd, personaDirs: [] });
    assert.equal(resolved.source, 'built-in');
    assert.equal(resolved.spec.id, 'persona-maker');
    assert.equal(resolved.selection.personaId, 'persona-maker');
    assert.equal(resolved.selection.harness, resolved.spec.harness);
    assert.equal(resolved.selection.model, resolved.spec.model);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('an explicit JSON path is the highest registry layer and inherits normally', () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-registry-path-'));
  const project = join(root, 'project');
  const external = join(root, 'external');
  mkdirSync(project, { recursive: true });
  mkdirSync(external, { recursive: true });
  const projectPersonas = join(project, '.agentworkforce', 'workforce', 'personas');
  mkdirSync(projectPersonas, { recursive: true });
  const path = join(external, 'review.json');
  writeFileSync(
    path,
    JSON.stringify({
      id: 'review-via-path',
      extends: 'persona-maker',
      description: 'Path-selected reviewer'
    })
  );
  writeFileSync(
    join(projectPersonas, 'conflict.json'),
    JSON.stringify({
      id: 'review-via-path',
      extends: 'persona-maker',
      description: 'Project persona that must not override an explicit path'
    })
  );

  try {
    const resolved = resolvePersonaReference(path, {
      cwd: project,
      personaDirs: []
    });
    assert.equal(resolved.source, 'path');
    assert.equal(resolved.path, path);
    assert.equal(resolved.spec.id, 'review-via-path');
    assert.equal(resolved.spec.description, 'Path-selected reviewer');
    assert.equal(resolved.selection.harness, resolved.spec.harness);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown names fail with a typed resolution error', () => {
  const cwd = mkdtempSync(join(tmpdir(), 'persona-registry-unknown-'));
  try {
  assert.throws(
    () => resolvePersonaReference('does-not-exist', { cwd, personaDirs: [] }),
    (error: unknown) =>
      error instanceof PersonaResolutionError && error.code === 'unknown_persona'
  );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("a repo's personas load from a subdirectory of it", () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-registry-repo-'));
  const repo = join(root, 'repo');
  const nested = join(repo, 'packages', 'deep');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(nested, { recursive: true });
  const personas = join(repo, '.agentworkforce', 'workforce', 'personas');
  mkdirSync(personas, { recursive: true });
  writeFileSync(
    join(personas, 'scout.json'),
    JSON.stringify({
      id: 'repo-scout',
      extends: 'persona-maker',
      description: 'Defined at the repo root'
    })
  );

  try {
    // Commands are typically run from a package directory, not the repo root.
    const fromNested = loadLocalPersonas({ cwd: nested, personaDirs: [] });
    assert.equal(fromNested.byId.get('repo-scout')?.description, 'Defined at the repo root');
    assert.equal(fromNested.sources.get('repo-scout'), 'repo');

    // The repo root itself still reports the persona as its own cwd layer,
    // with no duplicate repo entry.
    const fromRoot = loadLocalPersonas({ cwd: repo, personaDirs: [] });
    assert.equal(fromRoot.sources.get('repo-scout'), 'cwd');
    const rootDirs = buildPersonaSourceDirectories({ cwd: repo, personaDirs: [] }).directories;
    assert.equal(rootDirs.some((d) => String(d.source).startsWith('repo')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the cwd layer still outranks the repo root', () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-registry-rank-'));
  const repo = join(root, 'repo');
  const nested = join(repo, 'packages', 'deep');
  mkdirSync(join(repo, '.git'), { recursive: true });
  const repoPersonas = join(repo, '.agentworkforce', 'workforce', 'personas');
  const nestedPersonas = join(nested, '.agentworkforce', 'workforce', 'personas');
  mkdirSync(repoPersonas, { recursive: true });
  mkdirSync(nestedPersonas, { recursive: true });
  writeFileSync(
    join(repoPersonas, 'scout.json'),
    JSON.stringify({ id: 'scout', extends: 'persona-maker', description: 'repo root' })
  );
  writeFileSync(
    join(nestedPersonas, 'scout.json'),
    JSON.stringify({ id: 'scout', extends: 'persona-maker', description: 'package dir' })
  );

  try {
    const loaded = loadLocalPersonas({ cwd: nested, personaDirs: [] });
    assert.equal(loaded.byId.get('scout')?.description, 'package dir');
    assert.equal(loaded.sources.get('scout'), 'cwd');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the repo walk stops rather than escaping to the home directory', () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-registry-norepo-'));
  const loose = join(root, 'not', 'a', 'repo');
  mkdirSync(loose, { recursive: true });

  try {
    assert.equal(findRepoRoot(loose), undefined);
    const dirs = buildPersonaSourceDirectories({ cwd: loose, personaDirs: [] }).directories;
    assert.equal(dirs.some((d) => String(d.source).startsWith('repo')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
