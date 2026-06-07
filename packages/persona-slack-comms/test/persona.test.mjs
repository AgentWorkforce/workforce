import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import persona, { slackCommsPersona } from '../index.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const personasDir = join(pkgRoot, 'personas');
const personaPath = join(personasDir, 'slack-comms.json');
const personaJson = JSON.parse(readFileSync(personaPath, 'utf8'));

test('persona pack points at the personas dir', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.agentworkforce?.personas, 'personas');
});

test('default export and named export are the same object', () => {
  assert.equal(persona, slackCommsPersona);
});

test('compatibility export reads the persona pack JSON', () => {
  assert.deepEqual(persona, personaJson);
});

test('persona JSON has an id (required by `agentworkforce install`)', () => {
  assert.equal(persona.id, 'slack-comms');
  assert.equal(persona.intent, 'agent-relay-workflow');
});

test('persona has the expected harness/model', () => {
  assert.equal(persona.harness, 'codex');
  assert.equal(persona.model, 'openai-codex/gpt-5.3-codex');
});

test('agentsMd sidecar is referenced and shipped alongside the persona JSON', () => {
  assert.equal(persona.agentsMd, './slack-comms.md');
  // The sidecar must resolve inside the personas dir the pack ships.
  const sidecarPath = join(personasDir, 'slack-comms.md');
  assert.ok(existsSync(sidecarPath), 'slack-comms.md sidecar exists in personas/');
  const sidecar = readFileSync(sidecarPath, 'utf8');
  assert.ok(sidecar.startsWith('# slack-comms'));
  assert.ok(sidecar.includes('Writeback discipline'));
  // It must not inline a claudeMdContent the pack contradicts.
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

test('the three comms skills resolve to their published packages (no using-agent-relay)', () => {
  const expected = [
    '@agent-relay/setting-up-relayfile',
    '@agent-relay/orchestrating-agent-relay',
    '@agent-workforce/persona-relayfile-mount',
  ];
  assert.equal(persona.skills.length, expected.length);
  for (const source of expected) {
    const skill = persona.skills.find((s) => s.source === source);
    assert.ok(skill, `skill "${source}" present`);
  }
  // `using-agent-relay` was deliberately removed and must not return.
  assert.ok(
    !persona.skills.some((s) => /using-agent-relay/.test(s.source)),
    'using-agent-relay must not be present',
  );
});
