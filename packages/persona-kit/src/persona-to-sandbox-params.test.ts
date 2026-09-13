import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { personaToSandboxParams, PersonaNotSandboxableError } from './persona-to-sandbox-params.js';
import type { PersonaSpec, PersonaMount } from './types.js';

const persona: PersonaSpec = {
  id: 'demo', intent: 'documentation', description: '', tags: [], skills: [],
  harness: 'claude', harnessSettings: { reasoning: 'medium', timeoutSeconds: 300 },
};
for (const [name, mount, expected] of [
  ['no mount', undefined, []],
  ['one subtree', { ignoredPatterns: ['/*', '!web', '!web/**'] }, ['/web/**']],
  ['sorted and deduplicated', { ignoredPatterns: ['/*', '!web', '!web/**', '!api', '!api/**', '!web/**'] }, ['/api/**', '/web/**']],
  ['disabled', { enabled: false, ignoredPatterns: ['/*', '!web', '!web/**'] }, []],
  ['ordinary ignore', { ignoredPatterns: ['node_modules', '*.log'] }, []],
  ['mixed ignores', { ignoredPatterns: ['/*', '!web', '!web/**', 'web/private'] }, []],
  ['missing parent', { ignoredPatterns: ['/*', '!web/**'] }, []],
  ['nested subtree', { ignoredPatterns: ['/*', '!apps', '!apps/web', '!apps/web/**'] }, ['/apps/web/**']],
] as [string, PersonaMount | undefined, string[]][]) {
  test(`sandbox params: ${name}`, () => {
    const result = personaToSandboxParams({ ...persona, mount }, { workspace: 'ws' });
    assert.deepEqual(result.relayfilePaths, expected);
    assert.deepEqual(result.readonlyPaths, []);
  });
}
test('sandbox params: readonly, inputs, integration env, permissions and determinism', () => {
  const source = {
    ...persona,
    mount: { readonlyPatterns: ['docs/**'] },
    env: { Z: 'last', A: 'first' },
    permissions: { allow: ['Read'] },
    integrations: { github: { env: { GH_TOKEN: 'provided-token' } } },
  };
  const before = structuredClone(source);
  const ctx = { workspace: 'ws', inputs: { TOPIC: 'x' } };
  const a = personaToSandboxParams(source, ctx);
  const b = personaToSandboxParams(source, ctx);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(source, before);
  assert.deepEqual(Object.keys(a.env), Object.keys(a.env).sort());
  assert.equal(a.env.WORKFORCE_INPUT_TOPIC, 'x');
  assert.equal(a.env.WORKFORCE_WORKSPACE_ID, 'ws');
  assert.equal(a.env.WORKFORCE_PERSONA_ID, 'demo');
  assert.equal(a.env.GH_TOKEN, 'provided-token');
  assert.equal(a.label, 'wf-demo');
  assert.equal(a.permissions, source.permissions);
  assert.deepEqual(a.readonlyPaths, ['docs/**']);
  assert.notEqual(a.readonlyPaths, source.mount.readonlyPatterns);
});
test('sandbox params: deterministic error snapshots', () => {
  const fixture = new URL('../src/__fixtures__/persona-to-sandbox-params.errors.json', import.meta.url);
  const actual: Record<string, string> = {};
  for (const [reason, overrides] of [
    ['no-harness', { harness: undefined }],
    ['sandbox-disabled', { sandbox: false }],
    ['unsupported-harness', { harness: 'unknown' as PersonaSpec['harness'] }],
  ] as const) {
    assert.throws(() => personaToSandboxParams({ ...persona, ...overrides }, { workspace: 'ws' }), err => {
      assert.ok(err instanceof PersonaNotSandboxableError);
      assert.equal(err.reason, reason);
      actual[reason] = err.message;
      return true;
    });
  }
  if (process.env.UPDATE_SANDBOX_SNAPSHOTS === '1') writeFileSync(fixture, JSON.stringify(actual, null, 2) + '\n');
  assert.deepEqual(actual, JSON.parse(readFileSync(fixture, 'utf8')));
});
test('sandbox params: source purity', () => {
  const source = readFileSync(new URL('../src/persona-to-sandbox-params.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /node:fs|node:net|process\.env|\bDate\b/);
});
