import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import persona, { nangoIntegrationsPersona } from '../index.js';

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const personaPath = join(pkgRoot, 'personas', 'nango-integrations.json');
const personaJson = JSON.parse(readFileSync(personaPath, 'utf8'));

test('persona pack points at the personas dir', () => {
  const pkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
  assert.equal(pkg.agentworkforce?.personas, 'personas');
});

test('default export and named export are the same object', () => {
  assert.equal(persona, nangoIntegrationsPersona);
});

test('compatibility export reads the persona pack JSON', () => {
  assert.deepEqual(persona, personaJson);
});

test('persona JSON has an id (required by `agentworkforce install`)', () => {
  assert.equal(persona.id, 'nango-integrations');
  assert.equal(persona.intent, 'nango-integrations');
});

test('persona has the expected harness/model', () => {
  assert.equal(persona.harness, 'codex');
  assert.equal(persona.model, 'openai-codex/gpt-5.4');
});

test('manual is inlined as agentsMdContent (no external sidecar)', () => {
  assert.equal(typeof persona.agentsMdContent, 'string');
  assert.ok(persona.agentsMdContent.startsWith('# Nango Integrations Persona'));
  assert.ok(persona.agentsMdContent.includes('ADAPTERS registry'));
  // The spec must NOT reference file-based sidecars the pack doesn't ship.
  assert.equal(persona.agentsMd, undefined);
  assert.equal(persona.claudeMd, undefined);
});

test('nango docs MCP server is preserved', () => {
  assert.equal(persona.mcpServers.nango.type, 'http');
  assert.equal(persona.mcpServers.nango.url, 'https://nango.dev/docs/mcp');
});

test('skills are remotely sourced (no repo-local path that hard-fails launch)', () => {
  for (const skill of persona.skills) {
    assert.ok(
      !/\.(md)$/i.test(skill.source) || /^https?:\/\//.test(skill.source),
      `skill "${skill.id}" source must be remote (prpm/url), got "${skill.source}"`,
    );
  }
  const trigger = persona.skills.find((s) => s.id === 'trigger-autocomplete-catalog');
  assert.ok(trigger, 'trigger-autocomplete-catalog skill present');
  assert.equal(trigger.source, '@agent-relay/trigger-autocomplete-catalog');
});
