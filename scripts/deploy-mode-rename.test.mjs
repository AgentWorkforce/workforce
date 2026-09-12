import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('canonical deploy mode and launchers use local', () => {
  const read = name => readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
  assert.match(read('packages/deploy/src/types.ts'), /export type DeployMode = 'local' \| 'sandbox' \| 'cloud';/);
  for (const path of ['packages/cli/src/runtime-picker.ts', 'packages/local-surface/src/index.ts', 'packages/deploy/src/modes/local.ts']) {
    assert.doesNotMatch(read(path), /['"]dev['"]|--mode dev/);
  }
});
