import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MissingEnvRefError,
  makeEnvRefResolver,
  makeLenientResolver,
  resolveStringMap,
  resolveStringMapLenient
} from './env-refs.js';

test('resolves $VAR references against the provided env', () => {
  const resolve = makeEnvRefResolver({ FOO: 'hello' });
  assert.equal(resolve('$FOO', 'x'), 'hello');
});

test('passes literal strings through untouched', () => {
  const resolve = makeEnvRefResolver({ FOO: 'hello' });
  assert.equal(resolve('plain literal', 'x'), 'plain literal');
  assert.equal(resolve('Bearer hello-world', 'x'), 'Bearer hello-world');
});

test('refuses un-braced partial interpolation — prefix-$VAR stays literal', () => {
  // Unbraced `$VAR` mid-string is kept as-is so a stray `$` in a JSON value
  // doesn't get eaten by accident. Use ${VAR} for partial interpolation.
  const resolve = makeEnvRefResolver({ FOO: 'hello' });
  assert.equal(resolve('prefix-$FOO', 'x'), 'prefix-$FOO');
});

test('resolves braced ${VAR} interpolation anywhere in a string', () => {
  const resolve = makeEnvRefResolver({ POSTHOG_API_KEY: 'phx_abc' });
  assert.equal(resolve('Bearer ${POSTHOG_API_KEY}', 'auth'), 'Bearer phx_abc');
  assert.equal(resolve('${POSTHOG_API_KEY}-suffix', 'x'), 'phx_abc-suffix');
  assert.equal(resolve('${POSTHOG_API_KEY}', 'x'), 'phx_abc');
});

test('interpolates multiple ${VAR} occurrences in the same string', () => {
  const resolve = makeEnvRefResolver({ A: 'one', B: 'two' });
  assert.equal(resolve('${A}-${B}-${A}', 'x'), 'one-two-one');
});

test('missing ${VAR} inside a longer string errors with the field and var', () => {
  const resolve = makeEnvRefResolver({ FOO: 'ok' });
  assert.throws(
    () => resolve('Bearer ${MISSING_KEY}', 'headers.Authorization'),
    (err: unknown) =>
      err instanceof MissingEnvRefError &&
      err.ref === 'MISSING_KEY' &&
      err.referencedBy === 'headers.Authorization'
  );
});

test('throws MissingEnvRefError with the referenced name and field', () => {
  const resolve = makeEnvRefResolver({});
  assert.throws(
    () => resolve('$POSTHOG_API_KEY', 'env.POSTHOG_API_KEY'),
    (err: unknown) =>
      err instanceof MissingEnvRefError &&
      err.ref === 'POSTHOG_API_KEY' &&
      err.referencedBy === 'env.POSTHOG_API_KEY'
  );
});

test('treats empty-string env vars as missing (explicit unset)', () => {
  const resolve = makeEnvRefResolver({ FOO: '' });
  assert.throws(() => resolve('$FOO', 'x'), MissingEnvRefError);
});

test('resolveStringMap walks every value and reports the originating field', () => {
  const result = resolveStringMap(
    { A: '$FOO', B: 'literal' },
    { FOO: 'ok' },
    'env'
  );
  assert.deepEqual(result, { A: 'ok', B: 'literal' });

  assert.throws(
    () => resolveStringMap({ X: '$MISSING' }, {}, 'env'),
    (err: unknown) =>
      err instanceof MissingEnvRefError &&
      err.ref === 'MISSING' &&
      err.referencedBy === 'env.X'
  );
});

test('resolveStringMap returns undefined for undefined input', () => {
  assert.equal(resolveStringMap(undefined, {}, 'env'), undefined);
});

test('lenient resolver reports missing refs instead of throwing', () => {
  const resolve = makeLenientResolver({ FOO: 'ok' });
  assert.deepEqual(resolve('$FOO', 'x'), { ok: true, value: 'ok' });
  assert.deepEqual(resolve('$MISSING', 'env.K'), {
    ok: false,
    field: 'env.K',
    ref: 'MISSING'
  });
  assert.deepEqual(resolve('Bearer ${MISSING_KEY}', 'headers.Auth'), {
    ok: false,
    field: 'headers.Auth',
    ref: 'MISSING_KEY'
  });
});

test('resolveStringMapLenient drops missing entries and reports them', () => {
  const result = resolveStringMapLenient(
    {
      PRESENT: '$FOO',
      MISSING: '$NOPE',
      LITERAL: 'plain',
      PARTIAL_MISSING: 'Bearer ${NO_KEY}'
    },
    { FOO: 'value' },
    'env'
  );
  assert.deepEqual(result.value, { PRESENT: 'value', LITERAL: 'plain' });
  assert.deepEqual(
    result.dropped.map((d) => `${d.field}:${d.ref}`).sort(),
    ['env.MISSING:NOPE', 'env.PARTIAL_MISSING:NO_KEY']
  );
});

test('resolveStringMapLenient returns value=undefined when all entries dropped', () => {
  const result = resolveStringMapLenient(
    { A: '$MISSING' },
    {},
    'env'
  );
  assert.equal(result.value, undefined);
  assert.equal(result.dropped.length, 1);
});
