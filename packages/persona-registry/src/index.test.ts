import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { PersonaResolutionError, resolvePersonaReference } from './index.js';

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
