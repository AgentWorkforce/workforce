import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import persona, { linearDispatcherPersona } from '../index.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const personasDir = join(pkgRoot, 'personas');
const personaPath = join(personasDir, 'linear-dispatcher.json');
const personaJson = JSON.parse(readFileSync(personaPath, 'utf8'));

test('persona pack points at the personas dir', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.agentworkforce?.personas, 'personas');
});

test('default export and named export are the same object', () => {
  assert.equal(persona, linearDispatcherPersona);
});

test('compatibility export reads the persona pack JSON', () => {
  assert.deepEqual(persona, personaJson);
});

test('persona JSON has an id (required by `agentworkforce install`)', () => {
  assert.equal(persona.id, 'linear-dispatcher');
  assert.equal(persona.intent, 'agent-relay-workflow');
});

test('persona has the expected harness/model', () => {
  assert.equal(persona.harness, 'claude');
  assert.equal(persona.model, 'claude-sonnet-4-6');
});

test('agentsMd sidecar is referenced and shipped alongside the persona JSON', () => {
  assert.equal(persona.agentsMd, './linear-dispatcher.md');
  const sidecarPath = join(personasDir, 'linear-dispatcher.md');
  assert.ok(existsSync(sidecarPath), 'linear-dispatcher.md sidecar exists in personas/');
  const sidecar = readFileSync(sidecarPath, 'utf8');
  assert.ok(sidecar.startsWith('# linear-dispatcher'));
  assert.ok(sidecar.includes('Dispatch in batches of 5'));
  assert.equal(persona.claudeMdContent, undefined);
});

test('skills are remotely sourced (no repo-local path that hard-fails launch)', () => {
  for (const skill of persona.skills) {
    assert.ok(
      !/\.(md)$/i.test(skill.source) || /^https?:\/\//.test(skill.source),
      `skill "${skill.id}" source must be remote (prpm/url), got "${skill.source}"`,
    );
  }
});

