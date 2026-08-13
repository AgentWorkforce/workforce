import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import persona, { repoRouterPersona } from '../index.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const personasDir = join(pkgRoot, 'personas');
const personaPath = join(personasDir, 'repo-router.json');
const personaJson = JSON.parse(readFileSync(personaPath, 'utf8'));

test('persona pack points at the personas dir and ships skills', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.agentworkforce?.personas, 'personas');
  assert.ok(pkg.files.includes('skills'));
});

test('default export and named export are the same object', () => {
  assert.equal(persona, repoRouterPersona);
});

test('compatibility export reads the persona pack JSON', () => {
  assert.deepEqual(persona, personaJson);
});

test('persona JSON has the expected identity and runtime', () => {
  assert.equal(persona.id, 'repo-router');
  assert.equal(persona.intent, 'agent-relay-workflow');
  assert.equal(persona.harness, 'claude');
  assert.equal(persona.model, 'claude-sonnet-4-6');
});

test('agentsMd sidecar is referenced and shipped alongside the persona JSON', () => {
  assert.equal(persona.agentsMd, './repo-router.md');
  const sidecarPath = join(personasDir, 'repo-router.md');
  assert.ok(existsSync(sidecarPath), 'repo-router.md sidecar exists in personas/');
  const sidecar = readFileSync(sidecarPath, 'utf8');
  assert.ok(sidecar.startsWith('# repo-router'));
  assert.ok(sidecar.includes('Build a repo map from GitHub'));
  assert.ok(sidecar.includes('local `agentworkforce-repo-map` skill'));
  assert.equal(persona.claudeMdContent, undefined);
});

test('local skills are shipped and @agent-workforce skill sources are not used', () => {
  for (const skill of persona.skills) {
    assert.ok(
      skill.source !== '@agent-workforce/persona-relayfile-mount',
      '@agent-workforce/persona-relayfile-mount must not be used as a remote source'
    );
  }

  const localSources = [
    './skills/agentworkforce-repo-map.md',
    './skills/persona-relayfile-mount.md'
  ];
  for (const source of localSources) {
    const skill = persona.skills.find((s) => s.source === source);
    assert.ok(skill, `local skill "${source}" present`);
    assert.ok(existsSync(join(pkgRoot, source)), `local skill "${source}" shipped`);
  }
});
