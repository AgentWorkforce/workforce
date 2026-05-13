import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { pickRuntime } from './runtime-picker.js';

function input(value: string): Readable {
  return Readable.from([value]);
}

function output(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    }
  });
}

test('pickRuntime maps numeric choices to deploy modes', async () => {
  assert.equal(await pickRuntime({ input: input('1\n'), output: output() }), 'cloud');
  assert.equal(await pickRuntime({ input: input('2\n'), output: output() }), 'sandbox');
  assert.equal(await pickRuntime({ input: input('3\n'), output: output() }), 'dev');
});

test('pickRuntime defaults to cloud and returns docs for build-your-own', async () => {
  assert.equal(await pickRuntime({ input: input('\n'), output: output() }), 'cloud');
  assert.equal(await pickRuntime({ input: input('4\n'), output: output() }), 'docs');
});

test('pickRuntime rejects unknown choices', async () => {
  await assert.rejects(
    pickRuntime({ input: input('9\n'), output: output() }),
    /expected 1, 2, 3, or 4/
  );
});
