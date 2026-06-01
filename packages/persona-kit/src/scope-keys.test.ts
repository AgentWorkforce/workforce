import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_SCOPE_KEY_CATALOG,
  definePersona,
  type ScopeKeysFor
} from './index.js';

// Hard guarantee on the cross-repo seam: persona-kit's typed `scope` keys are
// only as good as the catalog it imports from @relayfile/adapter-core/scope-keys.
// If a future adapter-core release drops the export, regresses the github keys,
// or ships an empty/garbled catalog, these assertions fail persona-kit's CI —
// so a broken upstream can't silently degrade scope typing to "any string".

test('consumed scope-key catalog exposes github owner/repo', () => {
  assert.ok(KNOWN_SCOPE_KEY_CATALOG, 'KNOWN_SCOPE_KEY_CATALOG must be importable from adapter-core/scope-keys');
  assert.deepEqual([...(KNOWN_SCOPE_KEY_CATALOG.github ?? [])], ['owner', 'repo']);
});

test('ScopeKeysFor narrows to the provider scope keys; typed authoring accepts them', () => {
  // Type-level guard: github resolves to its declared keys.
  const owner: ScopeKeysFor<'github'> = 'owner';
  const repo: ScopeKeysFor<'github'> = 'repo';
  // @ts-expect-error 'nope' is not a github scope key
  const bad: ScopeKeysFor<'github'> = 'nope';
  void owner;
  void repo;
  void bad;

  const persona = definePersona({
    id: 'scope-typed',
    intent: 'review',
    description: 'scope typing fixture',
    integrations: {
      // Known keys autocomplete + are typed; arbitrary keys stay allowed.
      github: { scope: { owner: 'acme', repo: 'web' } },
      linear: { scope: { team: 'ENG' } }
    },
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 60 }
  });
  assert.equal(persona.integrations?.github?.scope?.owner, 'acme');
});
