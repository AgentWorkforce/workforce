#!/usr/bin/env node
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createGenerator } = require('ts-json-schema-generator');

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const schemaPath = resolve(packageRoot, 'schemas/persona.schema.json');
const agentSchemaPath = resolve(packageRoot, 'schemas/agent.schema.json');
const tsconfigPath = resolve(packageRoot, 'tsconfig.json');
const typesPath = resolve(packageRoot, 'src/types.ts');

const generator = createGenerator({
  path: typesPath,
  tsconfig: tsconfigPath,
  type: 'PersonaSpec',
  expose: 'export',
  topRef: true,
  jsDoc: 'extended',
  additionalProperties: true,
  sortProps: true,
  skipTypeCheck: true
});

const schema = generator.createSchema('PersonaSpec');
schema.$schema = 'https://json-schema.org/draft/2020-12/schema';
schema.$id = 'https://agentworkforce.dev/schemas/persona.schema.json';
const personaSpecSchema = schema.definitions?.PersonaSpec;
if (personaSpecSchema) {
  personaSpecSchema.allOf = [
    ...(personaSpecSchema.allOf ?? []),
    {
      if: {
        type: 'object',
        properties: {
          cloud: { const: true }
        },
        required: ['cloud']
      },
      then: {
        required: ['onEvent']
      }
    }
  ];
}

// Post-process: walk the schema and tighten the workspace_service_account.name
// constraint to match parse.ts (INTEGRATION_SOURCE_NAME_RE, max 64). The generator
// emits a bare `{ "type": "string" }` because the constraints live in the parser,
// not in the TS type. Without this, the schema accepts `""` which the parser then
// rejects at deploy time — better to fail at validation.
const SOURCE_NAME_PATTERN = '^[a-z0-9]+(?:-[a-z0-9]+)*$';
const SOURCE_NAME_MAX = 64;
function tightenWorkspaceServiceAccountName(node) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) tightenWorkspaceServiceAccountName(child);
    return;
  }
  // Match the object-literal variant: { kind: { const: 'workspace_service_account' }, name: { type: 'string' } }
  const props = node.properties;
  if (
    node.type === 'object' &&
    props &&
    props.kind &&
    props.kind.const === 'workspace_service_account' &&
    props.name &&
    props.name.type === 'string'
  ) {
    props.name = {
      ...props.name,
      minLength: 1,
      maxLength: SOURCE_NAME_MAX,
      pattern: SOURCE_NAME_PATTERN
    };
  }
  for (const value of Object.values(node)) tightenWorkspaceServiceAccountName(value);
}
tightenWorkspaceServiceAccountName(schema);

// Post-process: tighten the persona `tags[]` items to match parseTags
// (non-empty, ≤64 chars). The TS type widens to `readonly string[]` after
// cloud#553 — the generator emits a bare `{ "type": "string" }` because
// the bounds live in the parser. Without this, the schema accepts empty
// or 1MB tag strings that the parser would then reject. Match the
// `tightenWorkspaceServiceAccountName` post-process pattern above.
const PERSONA_TAG_MAX_LEN = 64;
const personaSpecForTags = schema.definitions?.PersonaSpec;
if (
  personaSpecForTags &&
  personaSpecForTags.properties?.tags?.type === 'array' &&
  personaSpecForTags.properties.tags.items?.type === 'string'
) {
  personaSpecForTags.properties.tags.items = {
    ...personaSpecForTags.properties.tags.items,
    minLength: 1,
    maxLength: PERSONA_TAG_MAX_LEN
  };
}

const serialized = `${JSON.stringify(schema, null, 2)}\n`;
await mkdir(dirname(schemaPath), { recursive: true });

let existing = '';
try {
  existing = await readFile(schemaPath, 'utf8');
} catch {
  // First emission.
}

if (existing !== serialized) {
  await writeFile(schemaPath, serialized);
}

// Emit the agent (`defineAgent`) schema from AgentSpec — the listener half of
// a deployed agent (triggers/schedules/watch) that travels to cloud as the
// deploy `agent` block.
const agentGenerator = createGenerator({
  path: typesPath,
  tsconfig: tsconfigPath,
  type: 'AgentSpec',
  expose: 'export',
  topRef: true,
  jsDoc: 'extended',
  additionalProperties: true,
  sortProps: true,
  skipTypeCheck: true
});

const agentSchema = agentGenerator.createSchema('AgentSpec');
agentSchema.$schema = 'https://json-schema.org/draft/2020-12/schema';
agentSchema.$id = 'https://agentworkforce.dev/schemas/agent.schema.json';

const agentSerialized = `${JSON.stringify(agentSchema, null, 2)}\n`;
let existingAgent = '';
try {
  existingAgent = await readFile(agentSchemaPath, 'utf8');
} catch {
  // First emission.
}

if (existingAgent !== agentSerialized) {
  await writeFile(agentSchemaPath, agentSerialized);
}
