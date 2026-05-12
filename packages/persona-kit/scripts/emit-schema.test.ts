import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePersonaSpec } from '../dist/parse.js';
import { lintTriggers } from '../dist/triggers.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = resolve(packageRoot, 'src/__fixtures__/personas');
const schemaPath = resolve(packageRoot, 'schemas/persona.schema.json');

test('persona fixtures validate against generated schema and parse', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const fixtureNames = (await readdir(fixturesDir)).filter((name) => name.endsWith('.json')).sort();

  assert.deepEqual(fixtureNames, [
    'cron-only.json',
    'full.json',
    'invalid-unknown-trigger.json',
    'minimal.json'
  ]);

  for (const fixtureName of fixtureNames) {
    const fixture = JSON.parse(await readFile(resolve(fixturesDir, fixtureName), 'utf8'));
    assertSchema(fixture, schema, schema, fixtureName);

    const parsed = parsePersonaSpec(fixture, fixture.intent);
    const triggerIssues = lintTriggers(parsed);
    if (fixtureName === 'invalid-unknown-trigger.json') {
      assert.equal(triggerIssues.length, 1);
      assert.equal(triggerIssues[0].code, 'unknown_trigger');
    } else {
      assert.deepEqual(triggerIssues, []);
    }
  }
});

test('emit-schema script is idempotent', async () => {
  const before = await readFile(schemaPath, 'utf8');
  execFileSync('node', [resolve(packageRoot, 'scripts/emit-schema.mjs')], {
    cwd: packageRoot,
    stdio: 'pipe'
  });
  const after = await readFile(schemaPath, 'utf8');
  assert.equal(after, before);
});

function assertSchema(value, schema, root, path) {
  if (schema.$ref) {
    return assertSchema(value, resolveRef(schema.$ref, root), root, path);
  }
  if (schema.anyOf) {
    const errors = [];
    for (const candidate of schema.anyOf) {
      try {
        assertSchema(value, candidate, root, path);
        return;
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error));
      }
    }
    throw new Error(`${path} must match one schema in anyOf: ${errors.join('; ')}`);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    throw new Error(`${path} must be one of: ${schema.enum.join(', ')}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.type) {
    assertType(value, schema.type, path);
  }
  if (schema.type === 'object' || schema.properties || schema.additionalProperties) {
    if (!isObject(value)) {
      throw new Error(`${path} must be an object`);
    }
    for (const requiredKey of schema.required ?? []) {
      if (!(requiredKey in value)) {
        throw new Error(`${path}.${requiredKey} is required`);
      }
    }
    const properties = schema.properties ?? {};
    for (const [key, childValue] of Object.entries(value)) {
      const childSchema = properties[key] ?? schema.additionalProperties;
      if (childSchema === false) {
        throw new Error(`${path}.${key} is not allowed`);
      }
      if (childSchema && childSchema !== true) {
        assertSchema(childValue, childSchema, root, `${path}.${key}`);
      }
    }
  }
  if (schema.type === 'array' || schema.items) {
    if (!Array.isArray(value)) {
      throw new Error(`${path} must be an array`);
    }
    if (schema.items) {
      value.forEach((item, index) => assertSchema(item, schema.items, root, `${path}[${index}]`));
    }
  }
}

function assertType(value, type, path) {
  const types = Array.isArray(type) ? type : [type];
  const ok = types.some((candidate) => {
    switch (candidate) {
      case 'array':
        return Array.isArray(value);
      case 'integer':
        return Number.isInteger(value);
      case 'null':
        return value === null;
      case 'object':
        return isObject(value);
      default:
        return typeof value === candidate;
    }
  });
  if (!ok) {
    throw new Error(`${path} must be ${types.join('|')}`);
  }
}

function resolveRef(ref, root) {
  const parts = ref.replace(/^#\//, '').split('/');
  let current = root;
  for (const part of parts) {
    current = current[part];
  }
  return current;
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
