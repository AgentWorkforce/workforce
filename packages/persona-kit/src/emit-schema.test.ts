import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parsePersonaSpec } from './parse.js';
import { lintTriggers } from './triggers.js';

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

test('generated schema requires onEvent for cloud personas', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const fixture = JSON.parse(await readFile(resolve(fixturesDir, 'minimal.json'), 'utf8'));

  assertSchema({ ...fixture, cloud: true, onEvent: './agent.ts' }, schema, schema, 'cloud-persona');
  assert.throws(
    () => assertSchema({ ...fixture, cloud: true }, schema, schema, 'cloud-persona'),
    /cloud-persona\.onEvent is required/
  );
});

test('generated schema reflects locked v1 persona fields', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as SchemaNode;
  const definitions = schema.definitions as Record<string, SchemaNode>;
  const personaSpec = definitions.PersonaSpec;
  const properties = personaSpec.properties ?? {};

  assert.equal('sandbox' in properties, false);
  assert.equal('traits' in properties, false);
  assert.deepEqual(definitions.PersonaMemoryScope.enum, ['workspace', 'user', 'global']);
  assert.equal('PersonaSandbox' in definitions, false);
  assert.equal('PersonaSandboxConfig' in definitions, false);
  assert.equal('PersonaTraits' in definitions, false);
});

type SchemaNode = Record<string, unknown> & {
  $ref?: string;
  allOf?: SchemaNode[];
  anyOf?: SchemaNode[];
  definitions?: Record<string, SchemaNode>;
  if?: SchemaNode;
  then?: SchemaNode;
  enum?: unknown[];
  const?: unknown;
  type?: string | string[];
  properties?: Record<string, SchemaNode | boolean>;
  additionalProperties?: SchemaNode | boolean;
  required?: string[];
  items?: SchemaNode;
};

function assertSchema(value: unknown, schema: SchemaNode, root: SchemaNode, path: string): void {
  if (schema.$ref) {
    return assertSchema(value, resolveRef(schema.$ref, root), root, path);
  }
  if (schema.allOf) {
    for (const candidate of schema.allOf) {
      assertSchema(value, candidate, root, path);
    }
  }
  if (schema.if && matchesSchema(value, schema.if, root, path) && schema.then) {
    assertSchema(value, schema.then, root, path);
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
    throw new Error(`${path} must be one of: ${schema.enum.map((v) => String(v)).join(', ')}`);
  }
  if (schema.const !== undefined && value !== schema.const) {
    throw new Error(`${path} must equal ${JSON.stringify(schema.const)}`);
  }
  if (schema.type) {
    assertType(value, schema.type, path);
  }
  if (schema.type === 'object' || schema.properties || schema.additionalProperties || schema.required) {
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
        assertSchema(childValue, childSchema as SchemaNode, root, `${path}.${key}`);
      }
    }
  }
  if (schema.type === 'array' || schema.items) {
    if (!Array.isArray(value)) {
      throw new Error(`${path} must be an array`);
    }
    if (schema.items) {
      value.forEach((item, index) =>
        assertSchema(item, schema.items as SchemaNode, root, `${path}[${index}]`)
      );
    }
  }
}

function matchesSchema(value: unknown, schema: SchemaNode, root: SchemaNode, path: string): boolean {
  try {
    assertSchema(value, schema, root, path);
    return true;
  } catch {
    return false;
  }
}

function assertType(value: unknown, type: string | string[], path: string): void {
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

function resolveRef(ref: string, root: SchemaNode): SchemaNode {
  const parts = ref.replace(/^#\//, '').split('/');
  let current: unknown = root;
  for (const part of parts) {
    current = (current as Record<string, unknown>)[part];
  }
  return current as SchemaNode;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
