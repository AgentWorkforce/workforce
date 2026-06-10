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

test('persona pack points at the personas dir', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.agentworkforce?.personas, 'personas');
});

test('default export and named export are the same object', () => {
  assert.equal(persona, repoRouterPersona);
});

test('compatibility export reads the persona pack JSON', () => {
  assert.deepEqual(persona, personaJson);
});

test('persona JSON has an id (required by `agentworkforce install`)', () => {
  assert.equal(persona.id, 'repo-router');
  assert.equal(persona.intent, 'agent-relay-workflow');
});

test('persona has the expected harness/model', () => {
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
  assert.equal(persona.claudeMdContent, undefined);
});

test('skills are remotely sourced (no repo-local path that hard-fails launch)', () => {
  for (const skill of persona.skills) {
    assert.ok(
      !/\.(md)$/i.test(skill.source) || /^https?:\/\//.test(skill.source),
      `skill "${skill.id}" source must be remote (prpm/url), got "${skill.source}"`,
    );
  }
  const repoMap = persona.skills.find((s) => s.id === 'agentworkforce-repo-map');
  assert.ok(repoMap, 'agentworkforce-repo-map skill present');
  assert.equal(repoMap.source, '@agent-workforce/agentworkforce-repo-map');
});

