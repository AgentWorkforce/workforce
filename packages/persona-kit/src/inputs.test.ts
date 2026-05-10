import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MissingPersonaInputError,
  renderPersonaInputs,
  resolvePersonaInputs
} from './inputs.js';

test('resolvePersonaInputs prefers explicit values over env and defaults', () => {
  const resolved = resolvePersonaInputs(
    {
      TARGET_DIR: {
        env: 'AW_TARGET_DIR',
        default: '/default/personas'
      }
    },
    { TARGET_DIR: '/explicit/personas' },
    { AW_TARGET_DIR: '/env/personas' }
  );
  assert.deepEqual(resolved.values, { TARGET_DIR: '/explicit/personas' });
});

test('resolvePersonaInputs falls back to configured env var then default', () => {
  assert.deepEqual(
    resolvePersonaInputs(
      {
        TARGET_DIR: { env: 'AW_TARGET_DIR', default: '/default/personas' },
        CREATE_MODE: { default: 'local' }
      },
      undefined,
      { AW_TARGET_DIR: '/env/personas' }
    ).values,
    {
      TARGET_DIR: '/env/personas',
      CREATE_MODE: 'local'
    }
  );
});

test('resolvePersonaInputs fails hard when a declared input is unset', () => {
  assert.throws(
    () => resolvePersonaInputs({ TARGET_DIR: {} }, undefined, {}),
    (err: unknown) =>
      err instanceof MissingPersonaInputError &&
      err.input === 'TARGET_DIR' &&
      err.env === 'TARGET_DIR'
  );
});

test('resolvePersonaInputs substitutes optional inputs with empty when unset', () => {
  // optional inputs are how a persona signals "this value may or may not
  // be forwarded; render to empty when it isn't" — used by sentinel-style
  // systemPrompts like "$TASK_DESCRIPTION" that should kick off the
  // harness only when the launcher provided the value.
  assert.deepEqual(
    resolvePersonaInputs(
      { TASK_DESCRIPTION: { optional: true } },
      undefined,
      {}
    ).values,
    { TASK_DESCRIPTION: '' }
  );
});

test('resolvePersonaInputs uses provided value over optional empty fallback', () => {
  assert.deepEqual(
    resolvePersonaInputs(
      { TASK_DESCRIPTION: { optional: true } },
      { TASK_DESCRIPTION: 'build a thing' },
      {}
    ).values,
    { TASK_DESCRIPTION: 'build a thing' }
  );
});

test('renderPersonaInputs substitutes $NAME and ${NAME} without touching longer names', () => {
  const rendered = renderPersonaInputs(
    'Write to $TARGET_DIR and ${CREATE_MODE}; leave $TARGET_DIR_SUFFIX alone.',
    {
      TARGET_DIR: '/tmp/personas',
      CREATE_MODE: 'local'
    }
  );
  assert.equal(
    rendered,
    'Write to /tmp/personas and local; leave $TARGET_DIR_SUFFIX alone.'
  );
});

test('renderPersonaInputs treats replacement values literally', () => {
  const rendered = renderPersonaInputs('Write to $TARGET_DIR in ${CREATE_MODE}.', {
    TARGET_DIR: '/tmp/$&/$CREATE_MODE/personas',
    CREATE_MODE: 'local'
  });
  assert.equal(rendered, 'Write to /tmp/$&/$CREATE_MODE/personas in local.');
});
