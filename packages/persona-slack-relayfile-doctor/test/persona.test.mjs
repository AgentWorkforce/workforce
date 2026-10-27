import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import persona, { slackRelayfileDoctorPersona } from '../index.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const personasDir = join(pkgRoot, 'personas');
const personaPath = join(personasDir, 'slack-relayfile-doctor.json');
const personaJson = JSON.parse(readFileSync(personaPath, 'utf8'));

test('persona pack points at the personas dir', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.agentworkforce?.personas, 'personas');
});

test('default export and named export are the same object', () => {
  assert.equal(persona, slackRelayfileDoctorPersona);
});

test('compatibility export reads the persona pack JSON', () => {
  assert.deepEqual(persona, personaJson);
});

test('persona id matches the JSON filename basename (required by validate + install)', () => {
  assert.equal(persona.id, 'slack-relayfile-doctor');
  assert.equal(persona.intent, 'agent-relay-workflow');
});

test('persona has the expected harness/model', () => {
  assert.equal(persona.harness, 'claude');
  assert.equal(persona.model, 'claude-sonnet-4-6');
});

test('trajectory + ai-memory facets are explicitly enabled (opt-in)', () => {
  // memory: true shorthand does NOT enable these; they must be declared.
  assert.equal(persona.memory?.trajectories?.enabled, true);
  assert.equal(persona.memory?.aiMemory?.enabled, true);
  assert.ok(
    Array.isArray(persona.memory?.scopes) && persona.memory.scopes.length > 0,
    'memory.scopes must be a non-empty array',
  );
});

test('claudeMd sidecar is referenced and shipped alongside the persona JSON', () => {
  assert.equal(persona.claudeMd, './slack-relayfile-doctor.md');
  const sidecarPath = join(personasDir, 'slack-relayfile-doctor.md');
  assert.ok(existsSync(sidecarPath), 'slack-relayfile-doctor.md sidecar exists in personas/');
  const sidecar = readFileSync(sidecarPath, 'utf8');
  assert.ok(sidecar.startsWith('# slack-relayfile-doctor'));
  assert.ok(sidecar.includes('Diagnostic toolkit'));
  assert.equal(persona.claudeMdContent, undefined);
  assert.equal(persona.agentsMd, undefined);
});

test('skills are remotely sourced (no repo-local path that hard-fails launch)', () => {
  for (const skill of persona.skills) {
    assert.ok(
      !/\.(md)$/i.test(skill.source) || /^https?:\/\//.test(skill.source),
      `skill "${skill.id}" source must be remote (prpm/url), got "${skill.source}"`,
    );
  }
});

test('the doctor skills are local @agent-relay skills (authored in this repo + registered in the top-level prpm.json)', () => {
  const expected = [
    '@agent-relay/slack-relayfile-writeback-debugging',
    '@agent-relay/slack-relayfile-readdown-debugging',
  ];
  assert.equal(persona.skills.length, expected.length);
  for (const source of expected) {
    assert.ok(
      persona.skills.find((s) => s.source === source),
      `skill "${source}" present`,
    );
  }
  // No external/unowned skill refs — all under the repo's @agent-relay publish org.
  for (const skill of persona.skills) {
    assert.ok(
      skill.source.startsWith('@agent-relay/'),
      `skill "${skill.source}" must be an @agent-relay (top-level prpm.json) skill`,
    );
  }
});
