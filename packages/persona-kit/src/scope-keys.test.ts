import test from 'node:test';
import assert from 'node:assert/strict';

import {
  KNOWN_SCOPE_KEY_CATALOG,
  definePersona,
  type ScopeKeysFor
} from './index.js';

// Hard guarantee on the cross-repo seam: persona-kit's typed `scope` keys are
// only as good as the catalog it imports from @relayfile/adapter-core/scope-keys.
// If a future adapter-core release drops the export, regresses the github/gitlab keys,
// or ships an empty/garbled catalog, these assertions fail persona-kit's CI —
// so a broken upstream can't silently degrade scope typing to "any string".

test('consumed scope-key catalog exposes github and gitlab keys', () => {
  assert.ok(KNOWN_SCOPE_KEY_CATALOG, 'KNOWN_SCOPE_KEY_CATALOG must be importable from adapter-core/scope-keys');
  assert.deepEqual([...(KNOWN_SCOPE_KEY_CATALOG.github ?? [])], ['owner', 'repo']);
  assert.deepEqual([...(KNOWN_SCOPE_KEY_CATALOG.gitlab ?? [])], ['projectPath']);
});

test('ScopeKeysFor narrows to the provider scope keys; typed authoring accepts them', () => {
  // Type-level guard: github resolves to its declared keys.
  const owner: ScopeKeysFor<'github'> = 'owner';
  const repo: ScopeKeysFor<'github'> = 'repo';
  const projectPath: ScopeKeysFor<'gitlab'> = 'projectPath';
  // @ts-expect-error 'nope' is not a github scope key
  const bad: ScopeKeysFor<'github'> = 'nope';
  // @ts-expect-error 'repo' is not a gitlab scope key
  const badGitlab: ScopeKeysFor<'gitlab'> = 'repo';
  void owner;
  void repo;
  void projectPath;
  void bad;
  void badGitlab;

  const persona = definePersona({
    id: 'scope-typed',
    intent: 'review',
    description: 'scope typing fixture',
    integrations: {
      // Known keys autocomplete + are typed; arbitrary keys stay allowed.
      github: { scope: { owner: 'acme', repo: 'web' } },
      gitlab: { scope: { projectPath: 'acme/web' } },
      linear: { scope: { team: 'ENG' } }
    },
    onEvent: './agent.ts',
    harnessSettings: { reasoning: 'low', timeoutSeconds: 60 }
  });
  assert.equal(persona.integrations?.github?.scope?.owner, 'acme');
  assert.equal(persona.integrations?.gitlab?.scope?.projectPath, 'acme/web');
});
