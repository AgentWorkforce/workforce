import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const publishWorkflow = readFileSync('.github/workflows/publish.yml', 'utf8');
const verifyWorkflow = readFileSync('.github/workflows/verify-publish.yml', 'utf8');

function publishPackageNames() {
  const match = publishWorkflow.match(/echo "packages=([^"]+)"/);
  assert.ok(match, 'publish workflow must declare its package targets');

  return match[1].split(/\s+/).map((directory) => {
    const packageJson = JSON.parse(readFileSync(`packages/${directory}/package.json`, 'utf8'));
    return packageJson.name;
  });
}

function verifyPackageChoices() {
  const lines = verifyWorkflow.split('\n');
  const packageInput = lines.findIndex((line) => line === '      package:');
  assert.notEqual(packageInput, -1, 'verify workflow must declare the package input');

  const options = lines.findIndex(
    (line, index) => index > packageInput && line === '        options:'
  );
  assert.notEqual(options, -1, 'verify package input must declare choices');

  const choices = [];
  for (const line of lines.slice(options + 1)) {
    const match = line.match(/^          - '([^']+)'$/);
    if (!match) break;
    choices.push(match[1]);
  }
  return choices;
}

test('Verify Publish exposes every lockstep package exactly once', () => {
  const published = publishPackageNames();
  const verified = verifyPackageChoices();

  assert.equal(new Set(published).size, published.length, 'publish targets must be unique');
  assert.equal(new Set(verified).size, verified.length, 'verify choices must be unique');
  assert.deepEqual(verified, published);
});

test('scoped CLI verification checks only the supported thin-entry contract', () => {
  const match = verifyWorkflow.match(
    /- name: Scoped CLI package smoke test([\s\S]*?)\n      - name: Library smoke test/
  );
  assert.ok(match, 'scoped CLI smoke step must exist');

  const step = match[1];
  assert.match(step, /assert\.equal\(pkg\.name, '@agentworkforce\/cli'\)/);
  assert.match(step, /assert\.equal\(pkg\.version, '\$\{\{ steps\.resolve\.outputs\.version \}\}'\)/);
  assert.match(step, /assert\.equal\(pkg\.bin, undefined\)/);
  assert.match(step, /@agentworkforce\/cli\/dist\/cli\.js/);
  assert.match(step, /assert\.equal\(typeof mod\.main, 'function'\)/);
  assert.doesNotMatch(step, /CLI_VERSION|cli-impl/);
});
