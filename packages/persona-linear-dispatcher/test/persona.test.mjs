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

test('persona pack points at the personas dir and ships skills', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.agentworkforce?.personas, 'personas');
  assert.ok(pkg.files.includes('skills'));
});

test('default export and named export are the same object', () => {
  assert.equal(persona, linearDispatcherPersona);
});

test('compatibility export reads the persona pack JSON', () => {
  assert.deepEqual(persona, personaJson);
});

test('persona JSON has the expected identity and runtime', () => {
  assert.equal(persona.id, 'linear-dispatcher');
  assert.equal(persona.intent, 'agent-relay-workflow');
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
  assert.ok(sidecar.includes('Ready for Agent'));
  assert.equal(persona.claudeMdContent, undefined);
});

test('mount policy skill is local and shipped with the persona pack', () => {
  const skill = persona.skills.find((s) => s.id === 'persona-relayfile-mount');
  assert.ok(skill, 'persona-relayfile-mount skill present');
  assert.equal(skill.source, './skills/persona-relayfile-mount.md');
  assert.ok(
    existsSync(join(pkgRoot, 'skills', 'persona-relayfile-mount.md')),
    'persona-relayfile-mount.md skill is shipped'
  );
  assert.ok(
    !persona.skills.some((s) => s.source === '@agent-workforce/persona-relayfile-mount'),
    '@agent-workforce/persona-relayfile-mount must not be used as a remote source'
  );
});
