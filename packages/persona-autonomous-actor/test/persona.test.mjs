import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import persona, { autonomousActorPersona } from '../index.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const personaPath = join(pkgRoot, 'personas', 'autonomous-actor.json');
const personaJson = JSON.parse(readFileSync(personaPath, 'utf8'));

test('persona pack points at the personas dir', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.agentworkforce?.personas, 'personas');
});

test('default export and named export are the same object', () => {
  assert.equal(persona, autonomousActorPersona);
});

test('compatibility export reads the persona pack JSON', () => {
  assert.deepEqual(persona, personaJson);
});

test('persona JSON has an id (required by `agentworkforce install`)', () => {
  assert.equal(persona.id, 'autonomous-actor');
  assert.equal(persona.intent, 'autonomous-cutover-delivery');
});

test('persona has the expected harness/model', () => {
  assert.equal(persona.harness, 'claude');
  assert.equal(persona.model, 'claude-opus-4-6');
});

test('manual is inlined as claudeMdContent (no external sidecar)', () => {
  assert.equal(typeof persona.claudeMdContent, 'string');
  assert.ok(persona.claudeMdContent.startsWith('# Autonomous Actor'));
  assert.ok(persona.claudeMdContent.includes('autonomous-run-contract'));
  // The spec must NOT reference file-based sidecars the pack doesn't ship.
  assert.equal(persona.agentsMd, undefined);
  assert.equal(persona.claudeMd, undefined);
});

test('skills are remotely sourced (no repo-local path that hard-fails launch)', () => {
  for (const skill of persona.skills) {
    assert.ok(
      !/\.(md)$/i.test(skill.source) || /^https?:\/\//.test(skill.source),
      `skill "${skill.id}" source must be remote (prpm/url), got "${skill.source}"`,
    );
  }
});

test('the six autonomous-run skills resolve to @agent-relay packages', () => {
  const expected = [
    'autonomous-run-contract',
    'auto-merge-and-composition-safety',
    'dormant-flip-and-rollback',
    'instrument-dont-guess',
    'swarm-blockers-and-gate-scoreboard',
    'tiered-acceptance',
  ];
  for (const id of expected) {
    const skill = persona.skills.find((s) => s.id === id);
    assert.ok(skill, `skill "${id}" present`);
    assert.equal(skill.source, `@agent-relay/${id}`);
  }
});
