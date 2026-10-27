import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
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

test('the repo walk stops at the home boundary and does not treat it as a repository', () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-registry-norepo-'));
  const home = join(root, 'home');
  const loose = join(home, 'not', 'a', 'repo');
  mkdirSync(loose, { recursive: true });
  // A dotfiles checkout at the boundary, plus another repository above it.
  // Neither may become the repo layer: home personas are the `user` layer.
  mkdirSync(join(home, '.git'), { recursive: true });
  mkdirSync(join(root, '.git'), { recursive: true });

  try {
    assert.equal(findRepoRoot(loose, home), undefined);
    assert.equal(findRepoRoot(home, home), undefined);

    const nearer = join(home, 'repo');
    const nested = join(nearer, 'packages', 'deep');
    mkdirSync(join(nearer, '.git'), { recursive: true });
    mkdirSync(nested, { recursive: true });
    assert.equal(findRepoRoot(nested, home), resolve(nearer));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('outside a repository the cascade has no repo layer', () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-registry-nolayer-'));
  const loose = join(root, 'not', 'a', 'repo');
  mkdirSync(loose, { recursive: true });

  try {
    // Temp directories sometimes live inside an ambient checkout. Assert the
    // cascade against that root instead of assuming the walk returns nothing.
    const found = findRepoRoot(loose);
    const dirs = buildPersonaSourceDirectories({ cwd: loose, personaDirs: [] }).directories;
    const repoLayers = dirs.filter((d) => String(d.source).startsWith('repo'));
    if (found === undefined) {
      assert.equal(repoLayers.length, 0);
      return;
    }
    const rootPrefix = found.endsWith(sep) ? found : found + sep;
    for (const layer of repoLayers) {
      assert.equal(resolve(layer.dir).startsWith(rootPrefix), true);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a persona dir already listed in personaDirs keeps its configured rank', () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-registry-configured-'));
  const repo = join(root, 'repo');
  const nested = join(repo, 'packages', 'deep');
  const company = join(root, 'company');
  const userPersonaDir = join(root, 'user-personas');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(nested, { recursive: true });
  mkdirSync(company, { recursive: true });
  mkdirSync(userPersonaDir, { recursive: true });
  const repoPersonas = join(repo, '.agentworkforce', 'workforce', 'personas');
  const agentDir = join(repo, '.agentworkforce', 'workforce', 'agents', 'proposal-agent');
  mkdirSync(repoPersonas, { recursive: true });
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(repoPersonas, 'scout.json'),
    JSON.stringify({ id: 'scout', extends: 'persona-maker', description: 'repo root' })
  );
  writeFileSync(
    join(company, 'scout.json'),
    JSON.stringify({ id: 'scout', extends: 'persona-maker', description: 'company override' })
  );
  writeFileSync(
    join(agentDir, 'persona.json'),
    JSON.stringify({ id: 'proposal-agent', extends: 'persona-maker', description: 'repo agent' })
  );

  const options = {
    cwd: nested,
    userPersonaDir,
    personaDirs: [company, repoPersonas]
  };

  try {
    const loaded = loadLocalPersonas(options);
    assert.equal(loaded.byId.get('scout')?.description, 'company override');
    assert.equal(loaded.sources.get('scout'), 'dir:1');
    assert.equal(loaded.sources.get('proposal-agent'), 'repo:agents');

    const dirs = buildPersonaSourceDirectories(options).directories;
    const personaEntries = dirs.filter((d) => resolve(d.dir) === resolve(repoPersonas));
    assert.equal(personaEntries.length, 1);
    assert.equal(personaEntries[0]?.source, 'dir:2');
    const companyIdx = dirs.findIndex((d) => resolve(d.dir) === resolve(company));
    const repoIdx = dirs.findIndex((d) => resolve(d.dir) === resolve(repoPersonas));
    const agentsIdx = dirs.findIndex((d) => d.source === 'repo:agents');
    assert.ok(companyIdx >= 0 && repoIdx > companyIdx);
    assert.ok(agentsIdx >= 0 && agentsIdx < companyIdx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a repo agents dir already listed in personaDirs keeps its configured rank', () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-registry-configured-agents-'));
  const repo = join(root, 'repo');
  const nested = join(repo, 'packages', 'deep');
  const company = join(root, 'company');
  const userPersonaDir = join(root, 'user-personas');
  const agents = join(repo, '.agentworkforce', 'workforce', 'agents');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(nested, { recursive: true });
  mkdirSync(company, { recursive: true });
  mkdirSync(join(agents, 'proposal-agent'), { recursive: true });
  mkdirSync(join(agents, 'repo-only'), { recursive: true });
  mkdirSync(userPersonaDir, { recursive: true });
  writeFileSync(
    join(company, 'proposal-agent.json'),
    JSON.stringify({ id: 'proposal-agent', extends: 'persona-maker', description: 'company override' })
  );
  writeFileSync(
    join(agents, 'proposal-agent', 'persona.json'),
    JSON.stringify({ id: 'proposal-agent', extends: 'persona-maker', description: 'repo agent' })
  );
  writeFileSync(
    join(agents, 'repo-only', 'persona.json'),
    JSON.stringify({ id: 'repo-only', extends: 'persona-maker', description: 'only in the repo' })
  );

  const options = {
    cwd: nested,
    userPersonaDir,
    personaDirs: [company, agents]
  };

  try {
    const loaded = loadLocalPersonas(options);
    assert.equal(loaded.byId.get('proposal-agent')?.description, 'company override');
    assert.equal(loaded.sources.get('proposal-agent'), 'dir:1');
    assert.equal(loaded.byId.get('repo-only')?.description, 'only in the repo');
    assert.equal(loaded.sources.get('repo-only'), 'dir:2');
    const dirs = buildPersonaSourceDirectories(options).directories;
    assert.equal(dirs.some((d) => d.source === 'repo:agents'), false);
    const agentEntries = dirs.filter((d) => resolve(d.dir) === resolve(agents));
    assert.equal(agentEntries.length, 1);
    assert.equal(agentEntries[0]?.source, 'dir:2');
    assert.equal(agentEntries[0]?.nested, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repo's agents load from a subdirectory of it", () => {
  const root = mkdtempSync(join(tmpdir(), 'persona-registry-repo-agents-'));
  const repo = join(root, 'repo');
  const nested = join(repo, 'packages', 'deep');
  const userPersonaDir = join(root, 'user-personas');
  mkdirSync(join(repo, '.git'), { recursive: true });
  mkdirSync(nested, { recursive: true });
  mkdirSync(userPersonaDir, { recursive: true });
  const agentDir = join(repo, '.agentworkforce', 'workforce', 'agents', 'proposal-agent');
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(
    join(agentDir, 'persona.json'),
    JSON.stringify({
      id: 'proposal-agent',
      extends: 'persona-maker',
      description: 'Defined at the repo root'
    })
  );

  try {
    const loaded = loadLocalPersonas({ cwd: nested, userPersonaDir, personaDirs: [] });
    assert.equal(loaded.byId.get('proposal-agent')?.description, 'Defined at the repo root');
    assert.equal(loaded.sources.get('proposal-agent'), 'repo:agents');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
