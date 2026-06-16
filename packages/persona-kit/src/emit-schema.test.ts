import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseAgentSpec, parsePersonaSpec } from './parse.js';
import { lintTriggers } from './triggers.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = resolve(packageRoot, 'src/__fixtures__/personas');
const agentFixturesDir = resolve(packageRoot, 'src/__fixtures__/agents');
const schemaPath = resolve(packageRoot, 'schemas/persona.schema.json');
const agentSchemaPath = resolve(packageRoot, 'schemas/agent.schema.json');

test('persona fixtures validate against generated schema and parse (connection-only)', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
  const fixtureNames = (await readdir(fixturesDir)).filter((name) => name.endsWith('.json')).sort();

  assert.deepEqual(fixtureNames, [
    'cron-only.json',
    'full.json',
    'integration-source-deployer.json',
    'integration-source-service-account.json',
    'integration-source-workspace.json',
    'invalid-unknown-trigger.json',
    'minimal.json',
    'proactive-watch-persona.json'
  ]);

  for (const fixtureName of fixtureNames) {
    const fixture = JSON.parse(await readFile(resolve(fixturesDir, fixtureName), 'utf8'));
    assertSchema(fixture, schema, schema, fixtureName);
    // Personas no longer carry triggers/schedules/watch — parse must succeed.
    parsePersonaSpec(fixture, fixture.intent);
  }
});

test('agent fixtures validate against agent schema, parse, and lint triggers', async () => {
  const schema = JSON.parse(await readFile(agentSchemaPath, 'utf8'));
  const fixtureNames = (await readdir(agentFixturesDir)).filter((name) => name.endsWith('.json')).sort();

  assert.deepEqual(fixtureNames, [
    'cron-only.agent.json',
    'full.agent.json',
    'integration-source-deployer.agent.json',
    'integration-source-service-account.agent.json',
    'integration-source-workspace.agent.json',
    'invalid-unknown-trigger.agent.json',
    'proactive-watch-persona.agent.json'
  ]);

  for (const fixtureName of fixtureNames) {
    const fixture = JSON.parse(await readFile(resolve(agentFixturesDir, fixtureName), 'utf8'));
    assertSchema(fixture, schema, schema, fixtureName);

    const parsed = parseAgentSpec(fixture);
    const triggerIssues = lintTriggers(parsed);
    if (fixtureName === 'invalid-unknown-trigger.agent.json') {
      assert.equal(triggerIssues.length, 1);
      assert.equal(triggerIssues[0].code, 'unknown_trigger');
    } else {
      assert.deepEqual(triggerIssues, []);
    }
  }
});

test('emit-schema script is idempotent (persona + agent schemas)', async () => {
  const before = await readFile(schemaPath, 'utf8');
  const agentBefore = await readFile(agentSchemaPath, 'utf8');
  execFileSync('node', [resolve(packageRoot, 'scripts/emit-schema.mjs')], {
    cwd: packageRoot,
    stdio: 'pipe'
  });
  assert.equal(await readFile(schemaPath, 'utf8'), before);
  assert.equal(await readFile(agentSchemaPath, 'utf8'), agentBefore);
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

  assert.equal('traits' in properties, false);
  assert.deepEqual(definitions.PersonaMemoryScope.enum, ['workspace', 'user', 'global']);
  assert.equal('PersonaSandbox' in definitions, false);
  assert.equal('PersonaSandboxConfig' in definitions, false);
  assert.equal('PersonaTraits' in definitions, false);
});

test('persona schema keeps mount.enabled but drops the moved listener fields', async () => {
  const schema = JSON.parse(await readFile(schemaPath, 'utf8')) as SchemaNode;
  const definitions = schema.definitions as Record<string, SchemaNode>;
  const personaSpec = definitions.PersonaSpec;
  const personaMount = definitions.PersonaMount;

  // Listener fields moved to the agent schema.
  assert.equal('watch' in (personaSpec.properties ?? {}), false);
  assert.equal('schedules' in (personaSpec.properties ?? {}), false);
  // Integration connection config no longer exposes triggers.
  assert.equal('triggers' in (definitions.PersonaIntegrationConfig.properties ?? {}), false);
  const integrationConfig = definitions.PersonaIntegrationConfig.properties?.config;
  assert.equal(integrationConfig && integrationConfig !== true
    ? integrationConfig.type
    : undefined, 'object');
  assert.deepEqual(integrationConfig && integrationConfig !== true
    ? integrationConfig.additionalProperties
    : undefined, {});
  assert.equal(personaMount.properties?.enabled && personaMount.properties.enabled !== true
    ? personaMount.properties.enabled.type
    : undefined, 'boolean');
});

test('agent schema exposes launchedBy/triggers/schedules/watch', async () => {
  const schema = JSON.parse(await readFile(agentSchemaPath, 'utf8')) as SchemaNode;
  const definitions = schema.definitions as Record<string, SchemaNode>;
  const agentSpec = definitions.AgentSpec;
  const watchRule = definitions.WatchRule;

  assert.equal(agentSpec.properties?.launchedBy && agentSpec.properties.launchedBy !== true
    ? agentSpec.properties.launchedBy.const
    : undefined, 'team-dispatcher');
  assert.equal(agentSpec.properties?.triggers && agentSpec.properties.triggers !== true
    ? agentSpec.properties.triggers.type
    : undefined, 'object');
  assert.equal(agentSpec.properties?.schedules && agentSpec.properties.schedules !== true
    ? agentSpec.properties.schedules.type
    : undefined, 'array');
  assert.equal(agentSpec.properties?.watch && agentSpec.properties.watch !== true
    ? agentSpec.properties.watch.type
    : undefined, 'array');
  assert.equal(watchRule.properties?.paths && watchRule.properties.paths !== true
    ? watchRule.properties.paths.type
    : undefined, 'array');
  const trigger = definitions.PersonaIntegrationTrigger;
  const maxConcurrency = trigger.properties?.maxConcurrency;
  assert.equal(maxConcurrency && maxConcurrency !== true
    ? maxConcurrency.type
    : undefined, 'integer');
  assert.equal(maxConcurrency && maxConcurrency !== true
    ? maxConcurrency.minimum
    : undefined, 1);

  assertSchema({ triggers: { slack: [{ on: 'message.created', maxConcurrency: 1 }] } }, schema, schema, 'agent');
  assert.throws(
    () => assertSchema({ triggers: { slack: [{ on: 'message.created', maxConcurrency: 0 }] } }, schema, schema, 'agent'),
    /agent\.triggers\.slack\[0\]\.maxConcurrency must be >= 1/
  );
  assert.throws(
    () => assertSchema({ triggers: { slack: [{ on: 'message.created', maxConcurrency: 1.5 }] } }, schema, schema, 'agent'),
    /agent\.triggers\.slack\[0\]\.maxConcurrency must be integer/
  );
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
  minimum?: number;
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
  if (typeof schema.minimum === 'number' && typeof value === 'number' && value < schema.minimum) {
    throw new Error(`${path} must be >= ${schema.minimum}`);
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
