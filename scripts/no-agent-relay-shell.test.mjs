import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const matcher = /\b(?:spawn|spawnSync|exec|execSync|execFile|execFileSync)\s*\(\s*(['"`])agent-relay\1/g;
function violations(source) {
  return [...source.matchAll(matcher)].map(match => source.slice(0, match.index).split('\n').length);
}
function* files(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (['dist', 'node_modules'].includes(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* files(path);
    else if (/\.(?:ts|mjs|js)$/.test(entry.name)) yield path;
  }
}
test('no-agent-relay-shell matcher detects every process invocation variant', () => {
  for (const fn of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync']) {
    for (const quote of ["'", '"', '`']) assert.deepEqual(violations(`${fn}(${quote}agent-relay${quote}, ['fleet'])`), [1]);
  }
  assert.deepEqual(violations("spawn('node', ['agent-relay.js'])"), []);
});
test('workforce packages compose Relay SDK rather than invoking its CLI', () => {
  const found = [];
  for (const file of files(join(root, 'packages'))) {
    for (const line of violations(readFileSync(file, 'utf8'))) found.push(`${relative(root, file)}:${line}`);
  }
  assert.deepEqual(found, [], `Forbidden agent-relay process invocation:\n${found.join('\n')}`);
});
