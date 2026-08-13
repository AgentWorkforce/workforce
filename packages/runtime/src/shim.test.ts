import test from 'node:test';
import assert from 'node:assert/strict';
import { handler, isWorkforceHandler } from './handler.js';

// Envelope → event decoding moved to `to-agent-event.ts` in v4 and is covered
// by `to-agent-event.test.ts`. This file now only covers handler branding.

test('handler() brands a function and round-trips identity', () => {
  let called = false;
  const fn = handler(async () => {
    called = true;
  });
  assert.equal(typeof fn, 'function');
  assert.equal(isWorkforceHandler(fn), true);
  assert.equal(isWorkforceHandler(() => {}), false);
  assert.equal(isWorkforceHandler('not a fn'), false);
  // Marker is non-enumerable so persona authors don't see it in iteration.
  assert.equal(Object.keys(fn).length, 0);
  // Identity: handler(f) returns the same callable f.
  fn({} as never, {} as never);
  assert.equal(called, true);
});

test('handler() rejects non-function inputs', () => {
  // @ts-expect-error intentional misuse
  assert.throws(() => handler('nope'), /expects a function/);
  // @ts-expect-error intentional misuse
  assert.throws(() => handler(undefined), /expects a function/);
});
