import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

// Pins the safety properties of the approval-gated fast path. Line-based, like
// release-workflows.test.mjs, so it needs no YAML dependency.
const lines = readFileSync('.github/workflows/fast-path.yml', 'utf8')
  .replaceAll('\r\n', '\n')
  .split('\n')
  .filter((line) => !/^\s*#/.test(line));

function block(start, indent) {
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.trim() === '') continue;
    if (line.length - line.trimStart().length <= indent) break;
    out.push(line);
  }
  return out;
}

function topLevel(key) {
  const index = lines.indexOf(`${key}:`);
  assert.notEqual(index, -1, `fast-path.yml must declare top-level ${key}`);
  return block(index, 0);
}

function jobs() {
  const body = topLevel('jobs');
  const result = new Map();
  let current;
  for (const line of body) {
    const name = line.match(/^ {2}([A-Za-z0-9_-]+):$/);
    if (name) {
      current = { environment: undefined, needs: [] };
      result.set(name[1], current);
      continue;
    }
    const env = line.match(/^ {4}environment:\s*(\S+)/);
    if (env) current.environment = env[1];
    const needs = line.match(/^ {4}needs:\s*(.+)$/);
    if (needs) {
      current.needs = needs[1].replace(/[[\]]/g, '').split(',').map((s) => s.trim()).filter(Boolean);
    }
  }
  return result;
}

test('fast path is triggered by workflow_dispatch only', () => {
  const triggers = topLevel('on').filter((line) => /^ {2}\S/.test(line));
  assert.deepEqual(triggers.map((line) => line.trim()), ['workflow_dispatch:']);
});

test('fast path top-level permissions are contents: read only', () => {
  assert.deepEqual(topLevel('permissions').map((line) => line.trim()), ['contents: read']);
});

test('only the gate job runs in the fast-path environment', () => {
  const all = jobs();
  const gated = [...all].filter(([, job]) => job.environment === 'fast-path').map(([name]) => name);
  assert.equal(gated.length, 1, 'exactly one job must use environment: fast-path');
  const [gate] = gated;
  assert.equal(all.get(gate).needs.length, 0, 'the gate job must not depend on another job');
  for (const [name, job] of all) {
    if (name !== gate) assert.equal(job.environment, undefined, `${name} must not set an environment`);
  }
});

test('every other job needs the gate, directly or transitively', () => {
  const all = jobs();
  const [gate] = [...all].find(([, job]) => job.environment === 'fast-path');
  const reaches = (name, seen = new Set()) => {
    if (name === gate) return true;
    if (seen.has(name)) return false;
    seen.add(name);
    return (all.get(name)?.needs ?? []).some((dep) => reaches(dep, seen));
  };
  for (const name of all.keys()) assert.ok(reaches(name), `${name} must depend on ${gate}`);
});
